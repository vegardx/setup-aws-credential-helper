import { Buffer } from "node:buffer";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { runCleanup } from "../src/cleanup.js";
import { runSetup, type ActionCore } from "../src/setup.js";
import type { ProfileMetadata } from "../src/types.js";

const roots: string[] = [];
let helperBundle: string;

function jwt(issuer: string): string {
  const now = Math.floor(Date.now() / 1000);
  return [
    Buffer.from("{}").toString("base64url"),
    Buffer.from(
      JSON.stringify({
        aud: "sts.amazonaws.com",
        iss: issuer,
        iat: now,
        nbf: now - 1,
        exp: now + 300,
      }),
    ).toString("base64url"),
    "signature",
  ].join(".");
}

function invokeHelper(
  metadataPath: string,
  env: NodeJS.ProcessEnv,
): Promise<{
  stdout: string;
  stderr: string;
  code: number | null;
}> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [helperBundle, metadataPath], {
      env: { ...process.env, ...env },
    });
    let stdout = "";
    let stderr = "";
    child.stdout
      .setEncoding("utf8")
      .on("data", (chunk: string) => (stdout += chunk));
    child.stderr
      .setEncoding("utf8")
      .on("data", (chunk: string) => (stderr += chunk));
    child.once("error", reject);
    child.once("close", (code) => resolve({ stdout, stderr, code }));
  });
}

beforeAll(async () => {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  await promisify(execFile)("npm", ["run", "build:helper:test"]);
  helperBundle = path.resolve("dist-test/helper.cjs");
});

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("mocked Linux end-to-end behavior", () => {
  it("runs concurrent real helper bundles with one OIDC/STS refresh", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "helper-e2e-"));
    roots.push(root);
    const cacheRoot = path.join(root, "cache");
    await mkdir(cacheRoot, { mode: 0o700 });
    let oidcCalls = 0;
    let stsCalls = 0;
    let serverPort = 0;
    const server = http.createServer(async (request, response) => {
      if (request.url?.startsWith("/oidc")) {
        oidcCalls += 1;
        expect(request.headers.authorization).toBe("Bearer request-secret");
        expect(request.url).toContain("audience=sts.amazonaws.com");
        response.setHeader("content-type", "application/json");
        response.end(
          JSON.stringify({ value: jwt(`http://127.0.0.1:${serverPort}`) }),
        );
        return;
      }
      if (request.url === "/") {
        stsCalls += 1;
        let body = "";
        for await (const chunk of request) body += String(chunk);
        expect(body).toContain("Action=AssumeRoleWithWebIdentity");
        expect(body).toContain("DurationSeconds=2");
        response.setHeader("content-type", "text/xml");
        response.end(`<?xml version="1.0" encoding="UTF-8"?>
<AssumeRoleWithWebIdentityResponse xmlns="https://sts.amazonaws.com/doc/2011-06-15/">
  <AssumeRoleWithWebIdentityResult><Credentials>
    <AccessKeyId>ASIAE2EEXAMPLE</AccessKeyId><SecretAccessKey>secret-e2e</SecretAccessKey>
    <SessionToken>session-e2e-${stsCalls}</SessionToken><Expiration>${new Date(Date.now() + 2_000).toISOString()}</Expiration>
  </Credentials></AssumeRoleWithWebIdentityResult>
  <ResponseMetadata><RequestId>request-id</RequestId></ResponseMetadata>
</AssumeRoleWithWebIdentityResponse>`);
        return;
      }
      response.statusCode = 404;
      response.end();
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("missing address");
    serverPort = address.port;
    try {
      const metadata: ProfileMetadata = {
        version: 1,
        name: "prod",
        roleArn: "arn:aws:iam::123456789012:role/prod",
        region: "us-east-1",
        audience: "sts.amazonaws.com",
        roleDurationSeconds: 2,
        partition: "aws",
        sessionName: "gha-1-1-prod",
        jobIdentity: {
          serverUrl: "https://github.com",
          repository: "owner/repo",
          workflow: "test",
          workflowRef: "",
          job: "test",
          runId: "1",
          runAttempt: "1",
          ref: "refs/heads/main",
        },
        stsEndpoint: `http://127.0.0.1:${address.port}/`,
        cacheRoot,
      };
      const metadataPath = path.join(root, "profile.json");
      await writeFile(metadataPath, JSON.stringify(metadata), { mode: 0o600 });
      const results = await Promise.all(
        Array.from({ length: 6 }, () =>
          invokeHelper(metadataPath, {
            ACTIONS_ID_TOKEN_REQUEST_URL: `http://127.0.0.1:${address.port}/oidc?api=1`,
            ACTIONS_ID_TOKEN_REQUEST_TOKEN: "request-secret",
            CREDENTIAL_HELPER_TEST_ALLOW_HTTP: "1",
            AWS_ENDPOINT_URL_STS: "http://localhost:1/",
            LOCALSTACK_ENDPOINT: "http://localhost:2/",
          }),
        ),
      );
      expect(oidcCalls).toBe(1);
      expect(stsCalls).toBe(1);
      const documents = results.map((result) => {
        expect(result.code).toBe(0);
        expect(result.stderr).toBe("");
        expect(result.stdout.endsWith("\n")).toBe(false);
        return JSON.parse(result.stdout) as Record<string, unknown>;
      });
      expect(
        new Set(documents.map((document) => JSON.stringify(document))).size,
      ).toBe(1);
      expect(documents[0]).toMatchObject({
        Version: 1,
        AccessKeyId: "ASIAE2EEXAMPLE",
        SecretAccessKey: "secret-e2e",
        SessionToken: "session-e2e-1",
      });

      const cached = await invokeHelper(metadataPath, {});
      expect(cached.code).toBe(0);
      expect(JSON.parse(cached.stdout)).toEqual(documents[0]);
      expect(oidcCalls).toBe(1);
      expect(stsCalls).toBe(1);

      await delay(1_100);
      const renewed = await invokeHelper(metadataPath, {
        ACTIONS_ID_TOKEN_REQUEST_URL: `http://127.0.0.1:${address.port}/oidc?api=1`,
        ACTIONS_ID_TOKEN_REQUEST_TOKEN: "request-secret",
      });
      expect(renewed.code).toBe(0);
      expect(JSON.parse(renewed.stdout)).toMatchObject({
        Version: 1,
        SessionToken: "session-e2e-2",
      });
      expect(oidcCalls).toBe(2);
      expect(stsCalls).toBe(2);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

  it("rejects malformed local endpoints and invalid metadata in the test bundle", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "helper-invalid-e2e-"));
    roots.push(root);
    const cacheRoot = path.join(root, "cache");
    await mkdir(cacheRoot, { mode: 0o700 });
    const validMetadata: ProfileMetadata = {
      version: 1,
      name: "prod",
      roleArn: "arn:aws:iam::123456789012:role/prod",
      region: "us-east-1",
      audience: "sts.amazonaws.com",
      roleDurationSeconds: 2,
      partition: "aws",
      sessionName: "gha-1-1-prod",
      jobIdentity: {
        serverUrl: "https://github.com",
        repository: "owner/repo",
        workflow: "test",
        workflowRef: "",
        job: "test",
        runId: "1",
        runAttempt: "1",
        ref: "refs/heads/main",
      },
      stsEndpoint: "http://127.0.0.1:4566/",
      cacheRoot,
    };
    const invalidMetadata: ProfileMetadata[] = [
      { ...validMetadata, roleArn: "not-an-arn" },
      { ...validMetadata, roleDurationSeconds: 0 },
      { ...validMetadata, audience: "bad audience" },
      { ...validMetadata, stsEndpoint: "http://localhost:4566/" },
      { ...validMetadata, stsEndpoint: "http://127.0.0.1:4566/path" },
      { ...validMetadata, stsEndpoint: "http://127.0.0.1:4566/?query=1" },
      { ...validMetadata, stsEndpoint: "http://user@127.0.0.1:4566/" },
    ];
    for (const [index, metadata] of invalidMetadata.entries()) {
      const metadataPath = path.join(root, `invalid-${index}.json`);
      await writeFile(metadataPath, JSON.stringify(metadata), { mode: 0o600 });
      const result = await invokeHelper(metadataPath, {
        ACTIONS_ID_TOKEN_REQUEST_URL: "http://127.0.0.1:4566/oidc",
        ACTIONS_ID_TOKEN_REQUEST_TOKEN: "unused",
      });
      expect(result.code, JSON.stringify(metadata)).not.toBe(0);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("profile metadata is incomplete");
    }
  });

  it("executes setup and cleanup against GitHub environment files", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "action-e2e-"));
    roots.push(root);
    const runnerTemp = path.join(root, "runner-temp");
    await mkdir(runnerTemp);
    const envFile = path.join(root, "github-env");
    const stateFile = path.join(root, "github-state");
    await writeFile(envFile, "");
    await writeFile(stateFile, "");
    const inputs = {
      profiles: JSON.stringify([
        {
          name: "prod",
          roleArn: "arn:aws:iam::123456789012:role/prod",
          region: "eu-west-1",
        },
      ]),
      "default-profile": "prod",
    };
    const actionCore: ActionCore = {
      getInput: (name) => inputs[name as keyof typeof inputs] ?? "",
      exportVariable: (name, value) => {
        const { appendFileSync } =
          require("node:fs") as typeof import("node:fs");
        appendFileSync(envFile, `${name}=${value}\n`);
      },
      saveState: (name, value) => {
        const { appendFileSync } =
          require("node:fs") as typeof import("node:fs");
        appendFileSync(stateFile, `${name}=${value}\n`);
      },
      setFailed: () => undefined,
      warning: () => undefined,
    };
    const directory = await runSetup({
      core: actionCore,
      env: { RUNNER_TEMP: runnerTemp, GITHUB_RUN_ID: "123" },
      platform: "linux",
      nodePath: process.execPath,
      actionPath: path.resolve("."),
    });
    expect((await stat(directory)).mode & 0o777).toBe(0o700);
    expect((await stat(path.join(directory, "aws-config"))).mode & 0o777).toBe(
      0o600,
    );
    const exported = await readFile(envFile, "utf8");
    expect(exported).toContain(
      `AWS_CONFIG_FILE=${path.join(directory, "aws-config")}`,
    );
    expect(exported).toContain("AWS_PROFILE=prod");
    expect(exported).not.toContain("AWS_REGION");
    expect(await readFile(stateFile, "utf8")).toBe(
      `generated-directory=${directory}\n`,
    );

    await runCleanup({
      core: { getState: () => directory, warning: () => undefined },
      env: { RUNNER_TEMP: runnerTemp },
    });
    await expect(stat(directory)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
