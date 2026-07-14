import { createHash, randomBytes } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  CACHE_FORMAT_VERSION,
  CACHE_IDENTITY_SCHEMA,
  type AwsCredentials,
  type CacheIdentity,
  type CacheRecord,
  type ProfileMetadata,
} from "./types.js";

const FILE_MODE = 0o600;
const DIRECTORY_MODE = 0o700;
const MAX_CACHE_FILE_BYTES = 64 * 1024;
const LOCK_WAIT_MS = 30_000;
const DEAD_OWNER_GRACE_MS = 120_000;
const MALFORMED_OWNER_GRACE_MS = 600_000;

export interface CacheDependencies {
  now: () => number;
  monotonicNow: () => number;
  sleep: (milliseconds: number) => Promise<void>;
  random: () => number;
  ownerToken: () => string;
  pid: number;
  processStartTime: () => Promise<string>;
  processIsSame: (
    pid: number,
    startTime: string,
  ) => Promise<boolean | undefined>;
}

async function linuxProcessStartTime(pid = process.pid): Promise<string> {
  const stat = await readFile(`/proc/${pid}/stat`, "utf8");
  const close = stat.lastIndexOf(")");
  const fields = stat.slice(close + 2).split(" ");
  const startTime = fields[19];
  if (!startTime) throw new Error("could not read process start time");
  return startTime;
}

const defaultDependencies: CacheDependencies = {
  now: Date.now,
  monotonicNow: () => performance.now(),
  sleep: (milliseconds) =>
    new Promise((resolve) => setTimeout(resolve, milliseconds)),
  random: Math.random,
  ownerToken: () => randomBytes(16).toString("hex"),
  pid: process.pid,
  processStartTime: () => linuxProcessStartTime(),
  processIsSame: async (pid, startTime) => {
    try {
      return (await linuxProcessStartTime(pid)) === startTime;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      return undefined;
    }
  },
};

export function cacheIdentity(metadata: ProfileMetadata): CacheIdentity {
  return {
    schema: CACHE_IDENTITY_SCHEMA,
    profileName: metadata.name,
    roleArn: metadata.roleArn,
    audience: metadata.audience,
    durationSeconds: metadata.roleDurationSeconds,
    sessionName: metadata.sessionName,
    jobIdentity: metadata.jobIdentity,
    partition: metadata.partition,
    stsEndpoint: metadata.stsEndpoint,
  };
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
    .join(",")}}`;
}

export function identityKey(identity: CacheIdentity): string {
  return createHash("sha256")
    .update(canonicalJson(identity), "utf8")
    .digest("hex");
}

function validCredentials(value: unknown): value is AwsCredentials {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return false;
  const credentials = value as Partial<AwsCredentials>;
  return (
    typeof credentials.accessKeyId === "string" &&
    /^ASIA[A-Z0-9]+$/.test(credentials.accessKeyId) &&
    typeof credentials.secretAccessKey === "string" &&
    credentials.secretAccessKey.length > 0 &&
    typeof credentials.sessionToken === "string" &&
    credentials.sessionToken.length > 0 &&
    typeof credentials.expiration === "string"
  );
}

function refreshWindow(durationSeconds: number): number {
  return Math.max(60_000, Math.min(300_000, durationSeconds * 100));
}

export function validateCacheRecord(
  value: unknown,
  identity: CacheIdentity,
  nowMs: number,
): CacheRecord | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return;
  const record = value as Partial<CacheRecord>;
  if (
    record.formatVersion !== CACHE_FORMAT_VERSION ||
    canonicalJson(record.identity) !== canonicalJson(identity) ||
    !validCredentials(record.credentials) ||
    typeof record.issuedAt !== "string" ||
    typeof record.expiration !== "string" ||
    record.credentials.expiration !== record.expiration
  ) {
    return;
  }
  const issuedAt = Date.parse(record.issuedAt);
  const expiration = Date.parse(record.expiration);
  if (
    !Number.isFinite(issuedAt) ||
    !Number.isFinite(expiration) ||
    issuedAt > nowMs + 60_000 ||
    issuedAt < nowMs - 43_200_000 - 300_000 ||
    expiration <= issuedAt ||
    expiration > issuedAt + identity.durationSeconds * 1000 + 300_000 ||
    nowMs >= expiration - refreshWindow(identity.durationSeconds)
  ) {
    return;
  }
  return record as CacheRecord;
}

async function readRecord(
  recordPath: string,
  identity: CacheIdentity,
  nowMs: number,
): Promise<CacheRecord | undefined> {
  try {
    const stat = await lstat(recordPath);
    if (
      stat.isSymbolicLink() ||
      !stat.isFile() ||
      stat.size > MAX_CACHE_FILE_BYTES ||
      (stat.mode & 0o077) !== 0
    ) {
      return;
    }
    const raw = await readFile(recordPath, "utf8");
    return validateCacheRecord(JSON.parse(raw) as unknown, identity, nowMs);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || error instanceof SyntaxError) return;
    throw error;
  }
}

interface LockOwner {
  version: 1;
  token: string;
  pid: number;
  processStartTime: string;
  createdAtMs: number;
  hostname: string;
}

async function writeExclusiveJson(
  filePath: string,
  value: unknown,
): Promise<void> {
  const handle = await open(
    filePath,
    fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL,
    FILE_MODE,
  );
  try {
    await handle.writeFile(`${JSON.stringify(value)}\n`, "utf8");
  } finally {
    await handle.close();
  }
  await chmod(filePath, FILE_MODE);
}

async function readOwner(lockPath: string): Promise<LockOwner | undefined> {
  try {
    const ownerPath = path.join(lockPath, "owner.json");
    const stat = await lstat(ownerPath);
    if (stat.isSymbolicLink() || !stat.isFile() || (stat.mode & 0o077) !== 0)
      return;
    const owner = JSON.parse(
      await readFile(ownerPath, "utf8"),
    ) as Partial<LockOwner>;
    if (
      owner.version !== 1 ||
      typeof owner.token !== "string" ||
      !Number.isInteger(owner.pid) ||
      typeof owner.processStartTime !== "string" ||
      typeof owner.createdAtMs !== "number" ||
      typeof owner.hostname !== "string"
    ) {
      return;
    }
    return owner as LockOwner;
  } catch {
    return;
  }
}

async function quarantineStaleLock(
  lockPath: string,
  token: string,
): Promise<boolean> {
  const quarantine = `${lockPath}.stale.${token}`;
  try {
    await rename(lockPath, quarantine);
    await rm(quarantine, { recursive: true, force: true });
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
    return false;
  }
}

async function recoverIfStale(
  lockPath: string,
  nowMs: number,
  token: string,
  dependencies: CacheDependencies,
): Promise<boolean> {
  const owner = await readOwner(lockPath);
  if (!owner) {
    try {
      const stat = await lstat(lockPath);
      return nowMs - stat.mtimeMs >= MALFORMED_OWNER_GRACE_MS
        ? quarantineStaleLock(lockPath, token)
        : false;
    } catch {
      return false;
    }
  }
  if (nowMs - owner.createdAtMs < DEAD_OWNER_GRACE_MS) return false;
  const sameProcess = await dependencies.processIsSame(
    owner.pid,
    owner.processStartTime,
  );
  return sameProcess === false ? quarantineStaleLock(lockPath, token) : false;
}

async function acquireLock(
  lockPath: string,
  dependencies: CacheDependencies,
): Promise<LockOwner> {
  const token = dependencies.ownerToken();
  const start = dependencies.monotonicNow();
  let processStartTime: string | undefined;
  while (dependencies.monotonicNow() - start < LOCK_WAIT_MS) {
    try {
      await mkdir(lockPath, { mode: DIRECTORY_MODE });
      processStartTime ??= await dependencies.processStartTime();
      const owner: LockOwner = {
        version: 1,
        token,
        pid: dependencies.pid,
        processStartTime,
        createdAtMs: dependencies.now(),
        hostname: os.hostname(),
      };
      try {
        await writeExclusiveJson(path.join(lockPath, "owner.json"), owner);
      } catch (error) {
        await rm(lockPath, { recursive: true, force: true });
        throw error;
      }
      return owner;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (
        await recoverIfStale(lockPath, dependencies.now(), token, dependencies)
      ) {
        continue;
      }
    }
    await dependencies.sleep(25 + Math.floor(dependencies.random() * 75));
  }
  throw new Error("timed out waiting for the credential cache refresh lock");
}

async function releaseLock(lockPath: string, owner: LockOwner): Promise<void> {
  const current = await readOwner(lockPath);
  if (current?.token !== owner.token) return;
  await rm(lockPath, { recursive: true, force: true });
}

async function cleanupTemporaryFiles(
  directory: string,
  key: string,
): Promise<void> {
  try {
    for (const name of await readdir(directory)) {
      if (name.startsWith(`.${key}.tmp.`) && /^[.a-f0-9]+$/.test(name)) {
        await rm(path.join(directory, name), { force: true });
      }
    }
  } catch {
    // Temporary-file cleanup is only an optimization.
  }
}

async function publishRecord(
  recordPath: string,
  key: string,
  record: CacheRecord,
  token: string,
): Promise<void> {
  const temporaryPath = path.join(
    path.dirname(recordPath),
    `.${key}.tmp.${token}`,
  );
  try {
    await writeExclusiveJson(temporaryPath, record);
    await rename(temporaryPath, recordPath);
  } finally {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}

export async function withCredentialCache(options: {
  metadata: ProfileMetadata;
  refresh: () => Promise<AwsCredentials>;
  dependencies?: CacheDependencies;
}): Promise<AwsCredentials> {
  const dependencies = options.dependencies ?? defaultDependencies;
  const identity = cacheIdentity(options.metadata);
  const key = identityKey(identity);
  const recordsDirectory = path.join(options.metadata.cacheRoot, "records-v1");
  const locksDirectory = path.join(options.metadata.cacheRoot, "locks-v1");
  await mkdir(recordsDirectory, { recursive: true, mode: DIRECTORY_MODE });
  await mkdir(locksDirectory, { recursive: true, mode: DIRECTORY_MODE });
  const recordPath = path.join(recordsDirectory, `${key}.json`);
  const lockPath = path.join(locksDirectory, `${key}.lock`);

  const optimistic = await readRecord(recordPath, identity, dependencies.now());
  if (optimistic) return optimistic.credentials;

  const owner = await acquireLock(lockPath, dependencies);
  try {
    const current = await readRecord(recordPath, identity, dependencies.now());
    if (current) return current.credentials;
    await cleanupTemporaryFiles(recordsDirectory, key);
    const issuedAtMs = dependencies.now();
    const credentials = await options.refresh();
    const expirationMs = Date.parse(credentials.expiration);
    if (
      !validCredentials(credentials) ||
      !Number.isFinite(expirationMs) ||
      expirationMs <= issuedAtMs + 60_000 ||
      expirationMs > issuedAtMs + identity.durationSeconds * 1000 + 300_000
    ) {
      throw new Error("AWS STS returned invalid or implausible credentials");
    }
    const record: CacheRecord = {
      formatVersion: CACHE_FORMAT_VERSION,
      identity,
      credentials,
      issuedAt: new Date(issuedAtMs).toISOString(),
      expiration: credentials.expiration,
    };
    await publishRecord(recordPath, key, record, owner.token);
    return credentials;
  } finally {
    await releaseLock(lockPath, owner).catch(() => undefined);
  }
}
