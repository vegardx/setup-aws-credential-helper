import {
  CloudFormationClient,
  CreateStackCommand,
  DeleteStackCommand,
  DescribeStackResourcesCommand,
  DescribeStacksCommand,
  UpdateStackCommand,
} from "@aws-sdk/client-cloudformation";
import {
  CreateBucketCommand,
  DeleteBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import {
  GetQueueAttributesCommand,
  GetQueueUrlCommand,
  SQSClient,
} from "@aws-sdk/client-sqs";
import { fromIni } from "@aws-sdk/credential-providers";
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { beforeAll, expect, test } from "vitest";

import type { ProcessCredentialDocument } from "../src/types.js";
import {
  sanitizeDiagnostics,
  type EmulatorAdapter,
  type EmulatorRun,
} from "./emulator/adapter.js";
import {
  createIdentityHarness,
  SPIKE_PROFILES,
  type IdentityHarness,
  type SpikeProfile,
} from "./emulator/identity.js";
import { motoAdapter } from "./emulator/moto.js";

const execFileAsync = promisify(execFile);
const region = "us-east-1";
let helperBundle: string;

interface SpikeMetrics {
  candidate: string;
  runnerOs: string;
  architecture: string;
  image: string;
  imageId: string;
  digest: string;
  version: string;
  startupMs: number;
  probeMs: number;
  cleanupMs: number;
  cleanupSucceeded: boolean;
  endpointQuirks: readonly string[];
}

beforeAll(async () => {
  await execFileAsync("npm", ["run", "build:helper:test"], {
    timeout: 60_000,
  });
  helperBundle = path.resolve("dist-test/helper.cjs");
});

function selectedAdapter(): EmulatorAdapter {
  return motoAdapter();
}

class AwsCliUnexpectedSuccess extends Error {}

async function awsCli(
  env: NodeJS.ProcessEnv,
  endpoint: string,
  args: string[],
  expectFailure = false,
): Promise<{ stdout: string; stderr: string }> {
  try {
    const result = await execFileAsync(
      "aws",
      ["--no-cli-pager", "--endpoint-url", endpoint, ...args],
      {
        env,
        encoding: "utf8",
        maxBuffer: 2 * 1024 * 1024,
        timeout: 30_000,
      },
    );
    if (expectFailure) {
      throw new AwsCliUnexpectedSuccess("AWS CLI unexpectedly succeeded");
    }
    return result;
  } catch (error) {
    if (error instanceof AwsCliUnexpectedSuccess) throw error;
    if (expectFailure && typeof error === "object" && error !== null) {
      return {
        stdout: String((error as { stdout?: unknown }).stdout ?? ""),
        stderr: String((error as { stderr?: unknown }).stderr ?? ""),
      };
    }
    throw error;
  }
}

function sdkCredentials(harness: IdentityHarness, profile: SpikeProfile) {
  return fromIni({
    configFilepath: harness.configPath,
    profile,
    ignoreCache: true,
  });
}

async function sdkS3Probe(options: {
  endpoint: string;
  harness: IdentityHarness;
  bucket: string;
}): Promise<void> {
  const client = new S3Client({
    endpoint: options.endpoint,
    region,
    forcePathStyle: true,
    credentials: sdkCredentials(options.harness, "identity"),
  });
  const key = "sdk-object.txt";
  try {
    await client.send(new CreateBucketCommand({ Bucket: options.bucket }));
    await client.send(
      new PutObjectCommand({
        Bucket: options.bucket,
        Key: key,
        Body: "created-by-sdk",
      }),
    );
    const created = await client.send(
      new GetObjectCommand({ Bucket: options.bucket, Key: key }),
    );
    expect(await created.Body?.transformToString()).toBe("created-by-sdk");

    await client.send(
      new PutObjectCommand({
        Bucket: options.bucket,
        Key: key,
        Body: "updated-by-sdk",
      }),
    );
    const updated = await client.send(
      new GetObjectCommand({ Bucket: options.bucket, Key: key }),
    );
    expect(await updated.Body?.transformToString()).toBe("updated-by-sdk");

    await client.send(
      new DeleteObjectCommand({ Bucket: options.bucket, Key: key }),
    );
    await expect(
      client.send(new HeadObjectCommand({ Bucket: options.bucket, Key: key })),
    ).rejects.toBeDefined();
    await client.send(new DeleteBucketCommand({ Bucket: options.bucket }));
    await expect(
      client.send(new HeadBucketCommand({ Bucket: options.bucket })),
    ).rejects.toBeDefined();
  } finally {
    client.destroy();
  }
}

async function cliS3Probe(options: {
  endpoint: string;
  harness: IdentityHarness;
  root: string;
  bucket: string;
}): Promise<void> {
  const env = options.harness.consumerEnv("deployment");
  const bodyPath = path.join(options.root, "cli-upload.txt");
  const downloadPath = path.join(options.root, "cli-download.txt");
  await awsCli(env, options.endpoint, [
    "s3api",
    "create-bucket",
    "--bucket",
    options.bucket,
  ]);
  await writeFile(bodyPath, "created-by-cli", { mode: 0o600 });
  await awsCli(env, options.endpoint, [
    "s3api",
    "put-object",
    "--bucket",
    options.bucket,
    "--key",
    "cli-object.txt",
    "--body",
    bodyPath,
  ]);
  await awsCli(env, options.endpoint, [
    "s3api",
    "get-object",
    "--bucket",
    options.bucket,
    "--key",
    "cli-object.txt",
    downloadPath,
  ]);
  expect(await readFile(downloadPath, "utf8")).toBe("created-by-cli");

  await writeFile(bodyPath, "updated-by-cli", { mode: 0o600 });
  await awsCli(env, options.endpoint, [
    "s3api",
    "put-object",
    "--bucket",
    options.bucket,
    "--key",
    "cli-object.txt",
    "--body",
    bodyPath,
  ]);
  await rm(downloadPath);
  await awsCli(env, options.endpoint, [
    "s3api",
    "get-object",
    "--bucket",
    options.bucket,
    "--key",
    "cli-object.txt",
    downloadPath,
  ]);
  expect(await readFile(downloadPath, "utf8")).toBe("updated-by-cli");

  await awsCli(env, options.endpoint, [
    "s3api",
    "delete-object",
    "--bucket",
    options.bucket,
    "--key",
    "cli-object.txt",
  ]);
  await awsCli(
    env,
    options.endpoint,
    [
      "s3api",
      "head-object",
      "--bucket",
      options.bucket,
      "--key",
      "cli-object.txt",
    ],
    true,
  );
  await awsCli(env, options.endpoint, [
    "s3api",
    "delete-bucket",
    "--bucket",
    options.bucket,
  ]);
  await awsCli(
    env,
    options.endpoint,
    ["s3api", "head-bucket", "--bucket", options.bucket],
    true,
  );
}

async function waitForStack(
  client: CloudFormationClient,
  stackName: string,
  expectedStatus: string,
): Promise<void> {
  const deadline = Date.now() + 60_000;
  let lastStatus = "unknown";
  while (Date.now() < deadline) {
    try {
      const output = await client.send(
        new DescribeStacksCommand({ StackName: stackName }),
      );
      lastStatus = output.Stacks?.[0]?.StackStatus ?? "missing";
      if (lastStatus === expectedStatus) return;
      if (lastStatus.includes("FAILED") || lastStatus.includes("ROLLBACK")) {
        throw new Error(`Stack entered ${lastStatus}`);
      }
    } catch (error) {
      if (expectedStatus === "DELETE_COMPLETE") return;
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error(`Stack did not reach ${expectedStatus}; last=${lastStatus}`);
}

function queueTemplate(queueName: string, visibilityTimeout: number): string {
  return JSON.stringify({
    AWSTemplateFormatVersion: "2010-09-09",
    Resources: {
      AcceptanceQueue: {
        Type: "AWS::SQS::Queue",
        Properties: {
          QueueName: queueName,
          VisibilityTimeout: visibilityTimeout,
        },
      },
    },
  });
}

async function cloudFormationProbe(options: {
  endpoint: string;
  harness: IdentityHarness;
  suffix: string;
}): Promise<void> {
  const credentials = sdkCredentials(options.harness, "cloudformation");
  const cloudFormation = new CloudFormationClient({
    endpoint: options.endpoint,
    region,
    credentials,
  });
  const sqs = new SQSClient({
    endpoint: options.endpoint,
    region,
    credentials: sdkCredentials(options.harness, "state"),
  });
  const stackName = `credential-helper-${options.suffix}`;
  const queueName = `credential-helper-${options.suffix}`;
  try {
    await cloudFormation.send(
      new CreateStackCommand({
        StackName: stackName,
        TemplateBody: queueTemplate(queueName, 30),
      }),
    );
    await waitForStack(cloudFormation, stackName, "CREATE_COMPLETE");

    const resources = await cloudFormation.send(
      new DescribeStackResourcesCommand({ StackName: stackName }),
    );
    const queueResource = resources.StackResources?.find(
      (resource) => resource.LogicalResourceId === "AcceptanceQueue",
    );
    expect(queueResource?.ResourceStatus).toBe("CREATE_COMPLETE");
    expect(queueResource?.PhysicalResourceId).toBeTruthy();

    const queue = await sqs.send(
      new GetQueueUrlCommand({ QueueName: queueName }),
    );
    expect(queue.QueueUrl).toContain(queueName);
    const createdAttributes = await sqs.send(
      new GetQueueAttributesCommand({
        QueueUrl: queue.QueueUrl,
        AttributeNames: ["VisibilityTimeout"],
      }),
    );
    expect(createdAttributes.Attributes?.VisibilityTimeout).toBe("30");

    await cloudFormation.send(
      new UpdateStackCommand({
        StackName: stackName,
        TemplateBody: queueTemplate(queueName, 45),
      }),
    );
    await waitForStack(cloudFormation, stackName, "UPDATE_COMPLETE");
    const updatedAttributes = await sqs.send(
      new GetQueueAttributesCommand({
        QueueUrl: queue.QueueUrl,
        AttributeNames: ["VisibilityTimeout"],
      }),
    );
    expect(updatedAttributes.Attributes?.VisibilityTimeout).toBe("45");

    await cloudFormation.send(new DeleteStackCommand({ StackName: stackName }));
    await waitForStack(cloudFormation, stackName, "DELETE_COMPLETE");
    await expect(
      sqs.send(new GetQueueUrlCommand({ QueueName: queueName })),
    ).rejects.toBeDefined();
  } finally {
    cloudFormation.destroy();
    sqs.destroy();
  }
}

async function unexpectedSuccessGuardControl(options: {
  endpoint: string;
  harness: IdentityHarness;
}): Promise<void> {
  await expect(
    awsCli(
      options.harness.consumerEnv("identity"),
      options.endpoint,
      ["s3api", "list-buckets"],
      true,
    ),
  ).rejects.toThrow("AWS CLI unexpectedly succeeded");
}

async function brokenCredentialProcessControl(options: {
  root: string;
  endpoint: string;
  harness: IdentityHarness;
}): Promise<void> {
  const brokenConfig = path.join(options.root, "broken-aws-config");
  await writeFile(
    brokenConfig,
    `[profile broken]\nregion = ${region}\ncredential_process = "${process.execPath}" -e "process.exit(23)"\n`,
    { mode: 0o600 },
  );
  const env = {
    ...options.harness.consumerEnv("identity"),
    AWS_CONFIG_FILE: brokenConfig,
    AWS_PROFILE: "broken",
  };
  const failure = await awsCli(
    env,
    options.endpoint,
    ["s3api", "list-buckets"],
    true,
  );
  expect(failure.stderr).toMatch(/credential|process/i);
}

function assertDistinctCredentials(
  credentials: Record<SpikeProfile, ProcessCredentialDocument>,
): void {
  expect(
    new Set(Object.values(credentials).map((item) => item.AccessKeyId)),
  ).toHaveLength(SPIKE_PROFILES.length);
  expect(
    new Set(Object.values(credentials).map((item) => item.SessionToken)),
  ).toHaveLength(SPIKE_PROFILES.length);
}

async function seedProfiles(
  harness: IdentityHarness,
): Promise<Record<SpikeProfile, ProcessCredentialDocument>> {
  const entries = await Promise.all(
    SPIKE_PROFILES.map(
      async (profile) => [profile, await harness.resolve(profile)] as const,
    ),
  );
  return Object.fromEntries(entries) as Record<
    SpikeProfile,
    ProcessCredentialDocument
  >;
}

test("runs the selected secretless emulator acceptance smoke test", async () => {
  const adapter = selectedAdapter();
  const root = await mkdtemp(path.join(os.tmpdir(), "emulator-spike-"));
  const suffix = randomBytes(5).toString("hex");
  let emulator: EmulatorRun | undefined;
  let harness: IdentityHarness | undefined;
  let probeStartedAt = 0;
  let probeMs = 0;
  let cleanupMs = 0;
  let cleanupSucceeded = false;
  let failure: unknown;
  try {
    emulator = await adapter.start();
    process.stdout.write(
      `${JSON.stringify({
        event: "emulator-started",
        candidate: adapter.name,
        runnerOs: process.env.RUNNER_OS ?? `${os.platform()} ${os.release()}`,
        architecture: process.arch,
        image: emulator.image.image,
        imageId: emulator.image.imageId,
        digest: emulator.image.digest,
        version: emulator.image.version,
        startupMs: emulator.startupMs,
      })}\n`,
    );
    harness = await createIdentityHarness({
      root,
      helperBundle,
      stsTarget: emulator.endpoint,
    });
    probeStartedAt = performance.now();
    const credentials = await seedProfiles(harness);
    assertDistinctCredentials(credentials);
    expect(harness.oidcCalls).toBe(4);
    expect(harness.stsCalls).toEqual({
      identity: 1,
      state: 1,
      deployment: 1,
      cloudformation: 1,
    });

    await sdkS3Probe({
      endpoint: emulator.endpoint,
      harness,
      bucket: `credential-helper-sdk-${suffix}`,
    });
    await cliS3Probe({
      endpoint: emulator.endpoint,
      harness,
      root,
      bucket: `credential-helper-cli-${suffix}`,
    });
    await cloudFormationProbe({
      endpoint: emulator.endpoint,
      harness,
      suffix,
    });
    await unexpectedSuccessGuardControl({
      endpoint: emulator.endpoint,
      harness,
    });
    await brokenCredentialProcessControl({
      root,
      endpoint: emulator.endpoint,
      harness,
    });

    expect(harness.oidcCalls).toBe(4);
    expect(harness.stsCalls).toEqual({
      identity: 1,
      state: 1,
      deployment: 1,
      cloudformation: 1,
    });
    probeMs = Math.round(performance.now() - probeStartedAt);
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    if (failure && emulator) {
      try {
        process.stderr.write(
          `${sanitizeDiagnostics(await emulator.diagnostics())}\n`,
        );
      } catch {
        process.stderr.write("Emulator diagnostics were unavailable.\n");
      }
    }
    if (harness) await harness.close();
    if (emulator) {
      const cleanup = await emulator.stop();
      cleanupMs = cleanup.cleanupMs;
      cleanupSucceeded = cleanup.removed;
    }
    await rm(root, { recursive: true, force: true });
    if (emulator) {
      const metrics: SpikeMetrics = {
        candidate: adapter.name,
        runnerOs: process.env.RUNNER_OS ?? `${os.platform()} ${os.release()}`,
        architecture: process.arch,
        image: emulator.image.image,
        imageId: emulator.image.imageId,
        digest: emulator.image.digest,
        version: emulator.image.version,
        startupMs: emulator.startupMs,
        probeMs:
          probeMs ||
          (probeStartedAt ? Math.round(performance.now() - probeStartedAt) : 0),
        cleanupMs,
        cleanupSucceeded,
        endpointQuirks: adapter.endpointQuirks,
      };
      process.stdout.write(
        `${JSON.stringify({ event: "emulator-finished", ...metrics })}\n`,
      );
    }
  }
}, 180_000);
