import {
  CreateBucketCommand,
  DeleteBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { fromIni } from "@aws-sdk/credential-providers";
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  copyFile,
  cp,
  mkdtemp,
  mkdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { beforeAll, expect, test } from "vitest";

import { sanitizeDiagnostics, type EmulatorRun } from "./emulator/adapter.js";
import {
  createIdentityHarness,
  type IdentityHarness,
  type SpikeProfile,
} from "./emulator/identity.js";
import { motoAdapter } from "./emulator/moto.js";

const execFileAsync = promisify(execFile);
const region = "us-east-1";
let helperBundle: string;

beforeAll(async () => {
  await execFileAsync("npm", ["run", "build:helper:test"], {
    timeout: 60_000,
  });
  helperBundle = path.resolve("dist-test/helper.cjs");
});

function cleanEnv(harness: IdentityHarness, profile: SpikeProfile) {
  return {
    ...harness.consumerEnv(profile),
    AWS_ACCESS_KEY_ID: undefined,
    AWS_SECRET_ACCESS_KEY: undefined,
    AWS_SESSION_TOKEN: undefined,
    AWS_ENDPOINT_URL: undefined,
    AWS_ENDPOINT_URL_STS: undefined,
  };
}

async function run(
  command: string,
  args: string[],
  options: { env?: NodeJS.ProcessEnv; cwd?: string; timeout?: number } = {},
) {
  return execFileAsync(command, args, {
    cwd: options.cwd,
    env: options.env,
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
    timeout: options.timeout ?? 120_000,
  });
}

async function aws(
  harness: IdentityHarness,
  endpoint: string,
  profile: SpikeProfile | undefined,
  args: string[],
) {
  const selected = profile ?? "identity";
  return run(
    "aws",
    [
      "--no-cli-pager",
      "--endpoint-url",
      endpoint,
      ...(profile ? ["--profile", profile] : []),
      ...args,
    ],
    { env: cleanEnv(harness, selected), timeout: 30_000 },
  );
}

function provider(harness: IdentityHarness, profile: SpikeProfile) {
  return fromIni({
    configFilepath: harness.configPath,
    profile,
    ignoreCache: true,
  });
}

async function credentialProcess(
  harness: IdentityHarness,
  profile: SpikeProfile,
) {
  return provider(harness, profile)();
}

async function waitForCounter(
  harness: IdentityHarness,
  profile: SpikeProfile,
  minimum: number,
) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const counters = await harness.invocationCalls();
    if (counters[profile] >= minimum) return counters;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(
    `credential_process ${profile} counter did not reach ${minimum}`,
  );
}

async function waitForGeneration(
  harness: IdentityHarness,
  profile: SpikeProfile,
  oidcMinimum: number,
  stsMinimum: number,
) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (
      harness.oidcCalls >= oidcMinimum &&
      harness.stsCalls[profile] >= stsMinimum
    ) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`${profile} OIDC/STS generation did not advance`);
}

async function sdkAndCliProbe(options: {
  harness: IdentityHarness;
  emulator: EmulatorRun;
  root: string;
  suffix: string;
  sdkOnly?: boolean;
}) {
  const bucket = `consumer-${options.suffix}`;
  const identity = new S3Client({
    endpoint: options.emulator.endpoint,
    region,
    forcePathStyle: true,
    credentials: provider(options.harness, "identity"),
  });
  try {
    await identity.send(new CreateBucketCommand({ Bucket: bucket }));
    await identity.send(
      new PutObjectCommand({ Bucket: bucket, Key: "sdk", Body: "sdk-body" }),
    );
    const sdkObject = await identity.send(
      new GetObjectCommand({ Bucket: bucket, Key: "sdk" }),
    );
    expect(await sdkObject.Body?.transformToString()).toBe("sdk-body");

    if (!options.sdkOnly) {
      await aws(options.harness, options.emulator.endpoint, undefined, [
        "s3api",
        "head-bucket",
        "--bucket",
        bucket,
      ]);
      const upload = path.join(options.root, "cli-body");
      await writeFile(upload, "cli-body", { mode: 0o600 });
      await aws(options.harness, options.emulator.endpoint, "deployment", [
        "s3api",
        "put-object",
        "--bucket",
        bucket,
        "--key",
        "cli",
        "--body",
        upload,
      ]);
      const listed = await aws(
        options.harness,
        options.emulator.endpoint,
        "deployment",
        ["s3api", "list-objects-v2", "--bucket", bucket],
      );
      expect(listed.stdout).toContain('"Key": "cli"');
    }

    const before = { ...options.harness.stsCalls };
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        credentialProcess(options.harness, "state"),
      ),
    );
    expect(new Set(results.map((item) => item.sessionToken)).size).toBe(1);
    expect(options.harness.stsCalls.state - before.state).toBe(1);
    await Promise.all(
      Array.from({ length: 4 }, () =>
        credentialProcess(options.harness, "state"),
      ),
    );
    expect(options.harness.stsCalls.state - before.state).toBe(1);
    expect(options.harness.stsCalls.identity).toBeGreaterThan(0);
    if (!options.sdkOnly) {
      expect(options.harness.stsCalls.deployment).toBeGreaterThan(0);
    }
    expect(options.harness.stsCalls.cloudformation).toBe(0);

    await identity.send(
      new DeleteObjectCommand({ Bucket: bucket, Key: "sdk" }),
    );
    if (!options.sdkOnly) {
      await identity.send(
        new DeleteObjectCommand({ Bucket: bucket, Key: "cli" }),
      );
    }
    await identity.send(new DeleteBucketCommand({ Bucket: bucket }));
    await expect(
      identity.send(new HeadBucketCommand({ Bucket: bucket })),
    ).rejects.toBeDefined();
  } finally {
    identity.destroy();
  }
}

async function naturalRenewalProbe(options: {
  emulator: EmulatorRun;
  root: string;
}) {
  const renewalRoot = path.join(options.root, "renewal");
  await mkdir(renewalRoot, { mode: 0o700 });
  const harness = await createIdentityHarness({
    root: renewalRoot,
    helperBundle,
    roleDurationSeconds: 4,
  });
  const previousUrl = process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
  const previousToken = process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  const renewalRuntime = harness.consumerEnv("identity");
  process.env.ACTIONS_ID_TOKEN_REQUEST_URL =
    renewalRuntime.ACTIONS_ID_TOKEN_REQUEST_URL;
  process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN =
    renewalRuntime.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  const bucket = `renewal-${randomBytes(5).toString("hex")}`;
  const client = new S3Client({
    endpoint: options.emulator.endpoint,
    region,
    forcePathStyle: true,
    credentials: provider(harness, "identity"),
  });
  try {
    await client.send(new CreateBucketCommand({ Bucket: bucket }));
    const first = await waitForCounter(harness, "identity", 1);
    const firstOidc = harness.oidcCalls;
    const firstSts = harness.stsCalls.identity;
    await client.send(new ListObjectsV2Command({ Bucket: bucket }));
    const immediate = await harness.invocationCalls();
    expect(immediate.identity).toBeGreaterThanOrEqual(first.identity);
    expect(harness.oidcCalls).toBe(firstOidc);
    expect(harness.stsCalls.identity).toBe(firstSts);
    await new Promise((resolve) => setTimeout(resolve, 3_700));
    await client.send(new ListObjectsV2Command({ Bucket: bucket }));
    const renewed = await waitForCounter(
      harness,
      "identity",
      immediate.identity + 1,
    );
    expect(renewed.identity).toBeGreaterThan(immediate.identity);
    await waitForGeneration(harness, "identity", firstOidc + 1, firstSts + 1);
    expect(harness.oidcCalls).toBeGreaterThan(firstOidc);
    expect(harness.stsCalls.identity).toBeGreaterThan(firstSts);
    const renewedOidc = harness.oidcCalls;
    const renewedSts = harness.stsCalls.identity;
    await client.send(new ListObjectsV2Command({ Bucket: bucket }));
    expect((await harness.invocationCalls()).identity).toBeGreaterThanOrEqual(
      renewed.identity,
    );
    expect(harness.oidcCalls).toBe(renewedOidc);
    expect(harness.stsCalls.identity).toBe(renewedSts);
    await client.send(new DeleteBucketCommand({ Bucket: bucket }));
  } finally {
    if (previousUrl === undefined)
      delete process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
    else process.env.ACTIONS_ID_TOKEN_REQUEST_URL = previousUrl;
    if (previousToken === undefined)
      delete process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
    else process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN = previousToken;
    client.destroy();
    await harness.close();
  }
}

async function copyIacFixture(
  engineRoot: string,
  engine: "terraform" | "opentofu",
) {
  await cp(
    path.resolve("tests/integration/iac/main.tf"),
    path.join(engineRoot, "main.tf"),
  );
  await copyFile(
    path.resolve(`tests/integration/iac/.terraform.lock.${engine}.hcl`),
    path.join(engineRoot, ".terraform.lock.hcl"),
  );
}

async function iacProbe(options: {
  engine: "terraform" | "opentofu";
  harness: IdentityHarness;
  emulator: EmulatorRun;
  root: string;
  suffix: string;
}) {
  const command = options.engine === "terraform" ? "terraform" : "tofu";
  const engineRoot = path.join(options.root, options.engine);
  await mkdir(engineRoot, { mode: 0o700 });
  await copyIacFixture(engineRoot, options.engine);
  const stateBucket = `state-${options.engine}-${options.suffix}`;
  const workloadBucket = `workload-${options.engine}-${options.suffix}`;
  const bootstrap = new S3Client({
    endpoint: options.emulator.endpoint,
    region,
    forcePathStyle: true,
    credentials: provider(options.harness, "identity"),
  });
  await bootstrap.send(new CreateBucketCommand({ Bucket: stateBucket }));
  await bootstrap.send(new CreateBucketCommand({ Bucket: workloadBucket }));
  bootstrap.destroy();

  const backend = path.join(engineRoot, "backend.generated.hcl");
  await writeFile(
    backend,
    `bucket = "${stateBucket}"
key = "${options.engine}/state.tfstate"
region = "${region}"
profile = "state"
shared_config_files = ["${options.harness.configPath}"]
endpoints = { s3 = "${options.emulator.endpoint}" }
use_path_style = true
skip_credentials_validation = true
skip_metadata_api_check = true
skip_region_validation = true
skip_requesting_account_id = true
skip_s3_checksum = true
`,
    { mode: 0o600 },
  );
  const env = {
    ...cleanEnv(options.harness, "identity"),
    TF_IN_AUTOMATION: "1",
    CHECKPOINT_DISABLE: "1",
  };
  const variables = [
    `-var=endpoint=${options.emulator.endpoint}`,
    `-var=bucket=${workloadBucket}`,
    `-var=prefix=${options.engine}`,
  ];
  const countersBefore = await options.harness.invocationCalls();
  let initialized = false;
  try {
    await run(command, ["init", "-input=false", `-backend-config=${backend}`], {
      cwd: engineRoot,
      env,
      timeout: 240_000,
    });
    initialized = true;
    await run(
      command,
      ["apply", "-auto-approve", "-input=false", ...variables],
      {
        cwd: engineRoot,
        env,
        timeout: 240_000,
      },
    );
    await run(command, ["refresh", "-input=false", ...variables], {
      cwd: engineRoot,
      env,
      timeout: 240_000,
    });
    await run(
      command,
      [
        "apply",
        "-auto-approve",
        "-input=false",
        ...variables,
        "-var=content=updated",
      ],
      { cwd: engineRoot, env, timeout: 240_000 },
    );

    const countersAfter = await options.harness.invocationCalls();
    expect(countersAfter.state).toBeGreaterThan(countersBefore.state);
    expect(countersAfter.deployment).toBeGreaterThan(
      countersBefore.deployment,
    );
    const cacheFiles = await run(
      "find",
      [path.join(options.root, "cache"), "-type", "f"],
      { env },
    );
    expect(
      cacheFiles.stdout.trim().split("\n").filter(Boolean).length,
    ).toBeGreaterThanOrEqual(2);
  } finally {
    if (initialized) {
      await run(
        command,
        ["destroy", "-auto-approve", "-input=false", ...variables],
        {
          cwd: engineRoot,
          env,
          timeout: 240_000,
        },
      ).catch(() => undefined);
    }
    const cleanup = new S3Client({
      endpoint: options.emulator.endpoint,
      region,
      forcePathStyle: true,
      credentials: provider(options.harness, "identity"),
    });
    for (const bucket of [workloadBucket, stateBucket]) {
      const objects = await cleanup
        .send(new ListObjectsV2Command({ Bucket: bucket }))
        .catch(() => undefined);
      for (const item of objects?.Contents ?? []) {
        if (item.Key) {
          await cleanup.send(
            new DeleteObjectCommand({ Bucket: bucket, Key: item.Key }),
          );
        }
      }
      await cleanup
        .send(new DeleteBucketCommand({ Bucket: bucket }))
        .catch(() => undefined);
    }
    cleanup.destroy();
  }
}

async function assertPrivateTree(root: string) {
  expect((await stat(root)).mode & 0o077).toBe(0);
}

test("real consumers use isolated profiles, shared cache, and natural renewal", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "offline-consumers-"));
  const suffix = randomBytes(5).toString("hex");
  let emulator: EmulatorRun | undefined;
  let harness: IdentityHarness | undefined;
  try {
    const externalEndpoint = process.env.MOTO_ENDPOINT;
    if (externalEndpoint) {
      emulator = {
        endpoint: externalEndpoint,
        image: {
          image: "motoserver/moto:latest",
          imageId: "managed-by-workflow",
          digest: "managed-by-workflow",
          version: "managed-by-workflow",
        },
        startupMs: 0,
        diagnostics: async () => "external Moto service",
        stop: async () => ({ cleanupMs: 0, removed: true }),
      };
    } else {
      emulator = await motoAdapter().start();
    }
    process.stdout.write(
      `${JSON.stringify({ event: "emulator-resolved", ...emulator.image, architecture: process.arch })}\n`,
    );
    harness = await createIdentityHarness({ root, helperBundle });
    const runtime = harness.consumerEnv("identity");
    process.env.ACTIONS_ID_TOKEN_REQUEST_URL =
      runtime.ACTIONS_ID_TOKEN_REQUEST_URL;
    process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN =
      runtime.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
    await assertPrivateTree(root);
    await sdkAndCliProbe({
      harness,
      emulator,
      root,
      suffix,
      sdkOnly: process.env.INTEGRATION_CONSUMERS === "sdk-only",
    });
    await naturalRenewalProbe({ emulator, root });

    if (
      process.env.INTEGRATION_CONSUMERS !== "core" &&
      process.env.INTEGRATION_CONSUMERS !== "sdk-only"
    ) {
      for (const engine of ["terraform", "opentofu"] as const) {
        await iacProbe({ engine, harness, emulator, root, suffix });
      }
    }
  } catch (error) {
    if (emulator) {
      process.stderr.write(
        `${sanitizeDiagnostics(await emulator.diagnostics())}\n`,
      );
    }
    throw error;
  } finally {
    if (harness) await harness.close();
    delete process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
    delete process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
    if (emulator && !process.env.MOTO_ENDPOINT) await emulator.stop();
    await rm(root, { recursive: true, force: true });
  }
}, 900_000);
