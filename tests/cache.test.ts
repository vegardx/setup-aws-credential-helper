import {
  mkdir,
  mkdtemp,
  readFile,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  cacheIdentity,
  canonicalJson,
  identityKey,
  validateCacheRecord,
  withCredentialCache,
  type CacheDependencies,
} from "../src/cache.js";
import type {
  AwsCredentials,
  CacheRecord,
  ProfileMetadata,
} from "../src/types.js";

const roots: string[] = [];
const now = Date.UTC(2026, 0, 1);

function metadata(cacheRoot: string, name = "prod"): ProfileMetadata {
  return {
    version: 1,
    name,
    roleArn: "arn:aws:iam::123456789012:role/prod",
    region: "eu-west-1",
    audience: "sts.amazonaws.com",
    roleDurationSeconds: 900,
    partition: "aws",
    sessionName: `gha-1-1-${name}`,
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
}

function credentials(offset = 900_000): AwsCredentials {
  return {
    accessKeyId: "ASIAEXAMPLE123",
    secretAccessKey: "secret",
    sessionToken: "session",
    expiration: new Date(now + offset).toISOString(),
  };
}

function dependencies(
  overrides: Partial<CacheDependencies> = {},
): CacheDependencies {
  let monotonic = 0;
  return {
    now: () => now,
    monotonicNow: () => monotonic,
    sleep: async (milliseconds) => {
      monotonic += milliseconds;
      await new Promise((resolve) => setTimeout(resolve, 1));
    },
    random: () => 0,
    ownerToken: () => "abcdef0123456789",
    pid: process.pid,
    processStartTime: async () => "100",
    processIsSame: async () => true,
    ...overrides,
  };
}

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function root(): Promise<string> {
  const value = await mkdtemp(path.join(os.tmpdir(), "cache-test-"));
  roots.push(value);
  return value;
}

describe("credential cache", () => {
  it("canonicalizes identities and isolates profile names", async () => {
    const cacheRoot = await root();
    expect(canonicalJson({ z: 1, a: { y: 2, b: 3 } })).toBe(
      '{"a":{"b":3,"y":2},"z":1}',
    );
    expect(identityKey(cacheIdentity(metadata(cacheRoot, "one")))).not.toBe(
      identityKey(cacheIdentity(metadata(cacheRoot, "two"))),
    );
  });

  it("single-flights concurrent refresh and publishes private records", async () => {
    const cacheRoot = await root();
    const profile = metadata(cacheRoot);
    let calls = 0;
    const refresh = async () => {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 30));
      return {
        ...credentials(),
        expiration: new Date(Date.now() + 900_000).toISOString(),
      };
    };
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        withCredentialCache({ metadata: profile, refresh }),
      ),
    );
    expect(calls).toBe(1);
    expect(results).toHaveLength(8);
    expect(new Set(results.map((result) => result.accessKeyId))).toEqual(
      new Set(["ASIAEXAMPLE123"]),
    );
    const key = identityKey(cacheIdentity(profile));
    const recordPath = path.join(cacheRoot, "records-v1", `${key}.json`);
    expect((await stat(recordPath)).mode & 0o777).toBe(0o600);
    const raw = await readFile(recordPath, "utf8");
    expect(raw).not.toContain("jwt");
    expect(raw).not.toContain("bearer");
  });

  it("treats early refresh boundaries and malformed records as misses", async () => {
    const profile = metadata(await root());
    const identity = cacheIdentity(profile);
    const base: CacheRecord = {
      formatVersion: 1,
      identity,
      credentials: credentials(),
      issuedAt: new Date(now).toISOString(),
      expiration: credentials().expiration,
    };
    expect(validateCacheRecord(base, identity, now)).toBeDefined();
    expect(
      validateCacheRecord(
        {
          ...base,
          credentials: credentials(59_000),
          expiration: credentials(59_000).expiration,
        },
        identity,
        now,
      ),
    ).toBeUndefined();
    expect(
      validateCacheRecord({ ...base, formatVersion: 2 }, identity, now),
    ).toBeUndefined();
    expect(
      validateCacheRecord(
        base,
        cacheIdentity(metadata(profile.cacheRoot, "other")),
        now,
      ),
    ).toBeUndefined();
  });

  it("rejects symlinked cache records", async () => {
    const cacheRoot = await root();
    const profile = metadata(cacheRoot);
    const key = identityKey(cacheIdentity(profile));
    const records = path.join(cacheRoot, "records-v1");
    await mkdir(records, { recursive: true, mode: 0o700 });
    const target = path.join(cacheRoot, "target");
    await writeFile(target, "{}", { mode: 0o600 });
    await symlink(target, path.join(records, `${key}.json`));
    const refresh = vi.fn().mockResolvedValue({
      ...credentials(),
      expiration: new Date(Date.now() + 900_000).toISOString(),
    });
    await withCredentialCache({ metadata: profile, refresh });
    expect(refresh).toHaveBeenCalledOnce();
  });

  it("does not break a live lock and fails closed on timeout", async () => {
    const cacheRoot = await root();
    const profile = metadata(cacheRoot);
    const key = identityKey(cacheIdentity(profile));
    const lock = path.join(cacheRoot, "locks-v1", `${key}.lock`);
    await mkdir(lock, { recursive: true, mode: 0o700 });
    await writeFile(
      path.join(lock, "owner.json"),
      JSON.stringify({
        version: 1,
        token: "other",
        pid: 1,
        processStartTime: "1",
        createdAtMs: now - 1_000_000,
        hostname: "host",
      }),
      { mode: 0o600 },
    );
    await expect(
      withCredentialCache({
        metadata: profile,
        refresh: vi.fn().mockResolvedValue(credentials()),
        dependencies: dependencies({ processIsSame: async () => true }),
      }),
    ).rejects.toThrow("timed out");
  });

  it("recovers a definitely dead stale owner", async () => {
    const cacheRoot = await root();
    const profile = metadata(cacheRoot);
    const key = identityKey(cacheIdentity(profile));
    const lock = path.join(cacheRoot, "locks-v1", `${key}.lock`);
    await mkdir(lock, { recursive: true, mode: 0o700 });
    await writeFile(
      path.join(lock, "owner.json"),
      JSON.stringify({
        version: 1,
        token: "dead",
        pid: 999999,
        processStartTime: "1",
        createdAtMs: now - 1_000_000,
        hostname: "host",
      }),
      { mode: 0o600 },
    );
    await expect(
      withCredentialCache({
        metadata: profile,
        refresh: vi.fn().mockResolvedValue(credentials()),
        dependencies: dependencies({ processIsSame: async () => false }),
      }),
    ).resolves.toEqual(credentials());
  });

  it("does not publish invalid refresh output", async () => {
    const profile = metadata(await root());
    await expect(
      withCredentialCache({
        metadata: profile,
        refresh: vi.fn().mockResolvedValue(credentials(10_000)),
      }),
    ).rejects.toThrow("invalid or implausible");
  });
});
