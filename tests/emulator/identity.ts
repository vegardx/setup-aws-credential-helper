import { Buffer } from "node:buffer";
import { spawn } from "node:child_process";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import http from "node:http";
import path from "node:path";

import type {
  ProcessCredentialDocument,
  ProfileMetadata,
} from "../../src/types.js";

export const SPIKE_PROFILES = [
  "identity",
  "state",
  "deployment",
  "cloudformation",
] as const;
export type SpikeProfile = (typeof SPIKE_PROFILES)[number];

const ACCOUNT_ID = "123456789012";
const REQUEST_TOKEN = "controlled-oidc-request-token";

export interface IdentityHarness {
  configPath: string;
  metadataPaths: Record<SpikeProfile, string>;
  oidcCalls: number;
  stsCalls: Record<SpikeProfile, number>;
  invocationCalls(): Promise<Record<SpikeProfile, number>>;
  resolve(profile: SpikeProfile): Promise<ProcessCredentialDocument>;
  consumerEnv(profile: SpikeProfile): NodeJS.ProcessEnv;
  close(): Promise<void>;
}

function jwt(issuer: string, audience: string): string {
  const now = Math.floor(Date.now() / 1000);
  return [
    Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString(
      "base64url",
    ),
    Buffer.from(
      JSON.stringify({
        aud: audience,
        iss: issuer,
        sub: "repo:owner/repository:ref:refs/heads/main",
        iat: now,
        nbf: now - 1,
        exp: now + 300,
      }),
    ).toString("base64url"),
    "controlled-signature",
  ].join(".");
}

function runHelper(
  helperBundle: string,
  metadataPath: string,
  env: NodeJS.ProcessEnv,
): Promise<ProcessCredentialDocument> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [helperBundle, metadataPath], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => child.kill("SIGKILL"), 20_000);
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (code) => {
      clearTimeout(timeout);
      if (code !== 0) {
        reject(new Error(`credential_process failed: ${stderr.trim()}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout) as ProcessCredentialDocument);
      } catch {
        reject(new Error("credential_process returned malformed JSON"));
      }
    });
  });
}

function safeBaseEnvironment(): NodeJS.ProcessEnv {
  const allowed = [
    "HOME",
    "PATH",
    "SystemRoot",
    "TMPDIR",
    "TEMP",
    "TMP",
    "NODE_EXTRA_CA_CERTS",
  ];
  return Object.fromEntries(
    allowed.flatMap((name) =>
      process.env[name] === undefined ? [] : [[name, process.env[name]]],
    ),
  );
}

function profileFromStsBody(body: string): SpikeProfile | undefined {
  const params = new URLSearchParams(body);
  const arn = params.get("RoleArn");
  return SPIKE_PROFILES.find(
    (profile) => arn === `arn:aws:iam::${ACCOUNT_ID}:role/${profile}`,
  );
}

function quote(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function syntheticStsResponse(
  profile: SpikeProfile,
  generation: number,
  durationSeconds: number,
): string {
  const profileCode = SPIKE_PROFILES.indexOf(profile) + 1;
  const suffix = `${profileCode}${generation}`.padStart(8, "0");
  return `<?xml version="1.0" encoding="UTF-8"?>
<AssumeRoleWithWebIdentityResponse xmlns="https://sts.amazonaws.com/doc/2011-06-15/">
  <AssumeRoleWithWebIdentityResult><Credentials>
    <AccessKeyId>ASIAOFFLINE${suffix}</AccessKeyId>
    <SecretAccessKey>controlled-secret-${profile}-${generation}</SecretAccessKey>
    <SessionToken>controlled-session-${profile}-${generation}</SessionToken>
    <Expiration>${new Date(Date.now() + durationSeconds * 1_000).toISOString()}</Expiration>
  </Credentials></AssumeRoleWithWebIdentityResult>
  <ResponseMetadata><RequestId>controlled-${profile}-${generation}</RequestId></ResponseMetadata>
</AssumeRoleWithWebIdentityResponse>`;
}

export async function createIdentityHarness(options: {
  root: string;
  helperBundle: string;
  stsTarget?: string;
  roleDurationSeconds?: number;
}): Promise<IdentityHarness> {
  const { root, helperBundle, stsTarget, roleDurationSeconds = 900 } = options;
  const cacheRoot = path.join(root, "cache");
  const profileRoot = path.join(root, "profiles");
  await mkdir(cacheRoot, { mode: 0o700 });
  await mkdir(profileRoot, { mode: 0o700 });

  let oidcCalls = 0;
  const stsCalls = Object.fromEntries(
    SPIKE_PROFILES.map((profile) => [profile, 0]),
  ) as Record<SpikeProfile, number>;
  let origin = "";

  const server = http.createServer(async (request, response) => {
    if (request.method === "GET" && request.url?.startsWith("/oidc")) {
      oidcCalls += 1;
      if (request.headers.authorization !== `Bearer ${REQUEST_TOKEN}`) {
        response.statusCode = 401;
        response.end();
        return;
      }
      const requestUrl = new URL(request.url, origin);
      const audience = requestUrl.searchParams.get("audience");
      if (!audience) {
        response.statusCode = 400;
        response.end();
        return;
      }
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ value: jwt(origin, audience) }));
      return;
    }

    if (request.method === "POST" && request.url === "/") {
      let body = "";
      for await (const chunk of request) body += String(chunk);
      const profile = profileFromStsBody(body);
      if (!profile) {
        response.statusCode = 400;
        response.end("invalid controlled role");
        return;
      }
      stsCalls[profile] += 1;
      if (!stsTarget) {
        response.setHeader("content-type", "text/xml");
        response.end(
          syntheticStsResponse(profile, stsCalls[profile], roleDurationSeconds),
        );
        return;
      }
      try {
        const upstream = await fetch(stsTarget, {
          method: "POST",
          headers: {
            "content-type":
              request.headers["content-type"] ??
              "application/x-www-form-urlencoded",
          },
          body,
          redirect: "error",
          signal: AbortSignal.timeout(10_000),
        });
        response.statusCode = upstream.status;
        const contentType = upstream.headers.get("content-type");
        if (contentType) response.setHeader("content-type", contentType);
        response.end(await upstream.text());
      } catch {
        response.statusCode = 502;
        response.end("controlled STS proxy failed");
      }
      return;
    }

    response.statusCode = 404;
    response.end();
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("controlled identity server has no TCP address");
  }
  origin = `http://127.0.0.1:${address.port}`;

  const metadataPaths = {} as Record<SpikeProfile, string>;
  const configLines: string[] = [];
  const invocationLogPath = path.join(root, "credential-process-invocations");
  const wrapperPath = path.join(root, "credential-process-wrapper.cjs");
  await writeFile(
    wrapperPath,
    `const fs = require("node:fs");
const { spawnSync } = require("node:child_process");
const [, , profile, logPath, helper, metadata] = process.argv;
fs.appendFileSync(logPath, profile + "\\n", { encoding: "utf8", mode: 0o600 });
const result = spawnSync(process.execPath, [helper, metadata], { env: process.env, stdio: "inherit" });
process.exit(result.status === null ? 1 : result.status);
`,
    { encoding: "utf8", flag: "wx", mode: 0o600 },
  );
  await writeFile(invocationLogPath, "", {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  try {
    for (const profile of SPIKE_PROFILES) {
      const metadataPath = path.join(profileRoot, `${profile}.json`);
      const metadata: ProfileMetadata = {
        version: 1,
        name: profile,
        roleArn: `arn:aws:iam::${ACCOUNT_ID}:role/${profile}`,
        region: "us-east-1",
        audience: "sts.amazonaws.com",
        roleDurationSeconds,
        partition: "aws",
        sessionName: `gha-1-1-${profile}`,
        jobIdentity: {
          serverUrl: "https://github.com",
          repository: "owner/repository",
          workflow: "emulator-spike",
          workflowRef:
            "owner/repository/.github/workflows/emulator-spike.yml@refs/heads/main",
          job: "acceptance",
          runId: "1",
          runAttempt: "1",
          ref: "refs/heads/main",
        },
        stsEndpoint: `${origin}/`,
        cacheRoot,
      };
      await writeFile(metadataPath, `${JSON.stringify(metadata)}\n`, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
      await chmod(metadataPath, 0o600);
      metadataPaths[profile] = metadataPath;
      const command = [
        process.execPath,
        wrapperPath,
        profile,
        invocationLogPath,
        helperBundle,
        metadataPath,
      ]
        .map(quote)
        .join(" ");
      configLines.push(
        `[profile ${profile}]`,
        "region = us-east-1",
        `credential_process = ${command}`,
        "",
      );
    }
    const configPath = path.join(root, "aws-config");
    await writeFile(configPath, `${configLines.join("\n")}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    await chmod(configPath, 0o600);

    const helperEnvironment = {
      ...safeBaseEnvironment(),
      ACTIONS_ID_TOKEN_REQUEST_URL: `${origin}/oidc?api-version=1`,
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: REQUEST_TOKEN,
    };

    return {
      configPath,
      metadataPaths,
      get oidcCalls() {
        return oidcCalls;
      },
      stsCalls,
      invocationCalls: async () => {
        const counts = Object.fromEntries(
          SPIKE_PROFILES.map((profile) => [profile, 0]),
        ) as Record<SpikeProfile, number>;
        const entries = (await readFile(invocationLogPath, "utf8"))
          .split("\n")
          .filter(Boolean);
        for (const entry of entries) {
          if (SPIKE_PROFILES.includes(entry as SpikeProfile)) {
            counts[entry as SpikeProfile] += 1;
          }
        }
        return counts;
      },
      resolve: (profile) =>
        runHelper(helperBundle, metadataPaths[profile], helperEnvironment),
      consumerEnv: (profile) => ({
        ...helperEnvironment,
        AWS_CONFIG_FILE: configPath,
        AWS_PROFILE: profile,
        AWS_SDK_LOAD_CONFIG: "1",
        AWS_EC2_METADATA_DISABLED: "true",
        AWS_CONTAINER_CREDENTIALS_FULL_URI: undefined,
        AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: undefined,
        AWS_WEB_IDENTITY_TOKEN_FILE: undefined,
        AWS_ROLE_ARN: undefined,
      }),
      close: () =>
        new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        ),
    };
  } catch (error) {
    server.close();
    throw error;
  }
}
