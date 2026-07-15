import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  processDocument,
  readProfileMetadata,
  runHelper,
} from "../src/helper.js";
import type { ProfileMetadata } from "../src/types.js";

const roots: string[] = [];

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("credential helper protocol", () => {
  it("formats exactly the AWS Version 1 process document", () => {
    expect(
      JSON.stringify(
        processDocument({
          accessKeyId: "ASIAEXAMPLE",
          secretAccessKey: "secret",
          sessionToken: "session",
          expiration: "2026-01-01T00:15:00.000Z",
        }),
      ),
    ).toBe(
      '{"Version":1,"AccessKeyId":"ASIAEXAMPLE","SecretAccessKey":"secret","SessionToken":"session","Expiration":"2026-01-01T00:15:00.000Z"}',
    );
  });

  it("emits only compact JSON to stdout on a valid cache hit", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "helper-test-"));
    roots.push(root);
    const cacheRoot = path.join(root, "cache");
    await mkdir(cacheRoot, { mode: 0o700 });
    const metadata: ProfileMetadata = {
      version: 1,
      name: "prod",
      roleArn: "arn:aws:iam::123456789012:role/prod",
      region: "eu-west-1",
      audience: "sts.amazonaws.com",
      roleDurationSeconds: 900,
      partition: "aws",
      sessionName: "gha-1-1-prod",
      jobIdentity: {
        serverUrl: "https://github.com",
        repository: "owner/repo",
        workflow: "deploy",
        workflowRef: "",
        job: "deploy",
        runId: "1",
        runAttempt: "1",
        ref: "refs/heads/main",
      },
      stsEndpoint: "https://sts.eu-west-1.amazonaws.com",
      cacheRoot,
    };
    const metadataPath = path.join(root, "metadata.json");
    await writeFile(metadataPath, JSON.stringify(metadata), { mode: 0o600 });
    const stdout = { write: vi.fn(() => true) };
    const expiration = new Date(Date.now() + 900_000);
    const send = vi.fn().mockResolvedValue({
      Credentials: {
        AccessKeyId: "ASIAEXAMPLE",
        SecretAccessKey: "secret",
        SessionToken: "session",
        Expiration: expiration,
      },
    });
    const nowSeconds = Math.floor(Date.now() / 1000);
    const token = [
      Buffer.from("{}").toString("base64url"),
      Buffer.from(
        JSON.stringify({
          aud: "sts.amazonaws.com",
          iss: "https://token.actions.githubusercontent.com",
          iat: nowSeconds,
          exp: nowSeconds + 300,
        }),
      ).toString("base64url"),
      "sig",
    ].join(".");
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ value: token }), { status: 200 }),
      );
    try {
      await runHelper({
        metadataPath,
        env: {
          ACTIONS_ID_TOKEN_REQUEST_URL:
            "https://token.actions.githubusercontent.com/?x=1",
          ACTIONS_ID_TOKEN_REQUEST_TOKEN: "bearer-secret",
        },
        stdout,
        stsClient: { send },
      });
      await runHelper({ metadataPath, env: {}, stdout, stsClient: { send } });
    } finally {
      globalThis.fetch = originalFetch;
    }
    const writes = stdout.write.mock.calls as unknown as Array<[string]>;
    expect(send).toHaveBeenCalledOnce();
    expect(stdout.write).toHaveBeenCalledTimes(2);
    expect(writes[0]![0]).toBe(writes[1]![0]);
    expect(writes[0]![0]).not.toContain("\n");
  });

  it("rejects symlinked or public metadata", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "metadata-test-"));
    roots.push(root);
    const publicFile = path.join(root, "public.json");
    await writeFile(publicFile, "{}", { mode: 0o644 });
    await expect(readProfileMetadata(publicFile)).rejects.toThrow("private");
    const link = path.join(root, "link.json");
    const { symlink } = await import("node:fs/promises");
    await symlink(publicFile, link);
    await expect(readProfileMetadata(link)).rejects.toThrow("private");
  });
});
