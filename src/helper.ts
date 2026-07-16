declare const __TEST_ALLOW_LOCAL_HTTP__: boolean;

import { lstat, readFile } from "node:fs/promises";
import path from "node:path";

import {
  isValidEffectiveProfile,
  type EffectiveProfileValidationInput,
} from "./input.js";
import { withCredentialCache } from "./cache.js";
import { acquireOidcToken } from "./oidc.js";
import { exchangeWebIdentity, type StsClientLike } from "./sts.js";
import {
  PROFILE_METADATA_VERSION,
  type ProcessCredentialDocument,
  type ProfileMetadata,
} from "./types.js";

function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : "unknown failure";
  return message
    .replaceAll(/https?:\/\/[^\s]+/g, "[url]")
    .replaceAll(/eyJ[A-Za-z0-9_.-]+/g, "[token]")
    .replaceAll(/[\r\n\p{Cc}]/gu, " ")
    .slice(0, 500);
}

export async function readProfileMetadata(
  metadataPath: string,
): Promise<ProfileMetadata> {
  if (!path.isAbsolute(metadataPath)) {
    throw new Error("profile metadata path must be absolute");
  }
  const stat = await lstat(metadataPath);
  if (stat.isSymbolicLink() || !stat.isFile() || (stat.mode & 0o077) !== 0) {
    throw new Error("profile metadata must be a private regular file");
  }
  const value = JSON.parse(await readFile(metadataPath, "utf8")) as unknown;
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    (value as Partial<ProfileMetadata>).version !== PROFILE_METADATA_VERSION
  ) {
    throw new Error("profile metadata has an unsupported format");
  }
  const metadata = value as ProfileMetadata;
  const effective: EffectiveProfileValidationInput = {
    name: metadata.name,
    roleArn: metadata.roleArn,
    region: metadata.region,
    audience: metadata.audience,
    roleDurationSeconds: metadata.roleDurationSeconds,
    partition: metadata.partition,
    sessionName: metadata.sessionName,
    stsEndpoint: metadata.stsEndpoint,
  };
  if (
    !path.isAbsolute(metadata.cacheRoot) ||
    !isValidEffectiveProfile(effective, {
      allowTestLoopbackStsEndpoint: __TEST_ALLOW_LOCAL_HTTP__,
    })
  ) {
    throw new Error("profile metadata is incomplete");
  }
  return metadata;
}

export function processDocument(
  credentials: Awaited<ReturnType<typeof withCredentialCache>>,
): ProcessCredentialDocument {
  return {
    Version: 1,
    AccessKeyId: credentials.accessKeyId,
    SecretAccessKey: credentials.secretAccessKey,
    SessionToken: credentials.sessionToken,
    Expiration: credentials.expiration,
  };
}

export async function runHelper(options: {
  metadataPath: string;
  env?: NodeJS.ProcessEnv;
  stdout?: Pick<NodeJS.WriteStream, "write">;
  stsClient?: StsClientLike;
}): Promise<void> {
  const metadata = await readProfileMetadata(options.metadataPath);
  const env = options.env ?? process.env;
  const credentials = await withCredentialCache({
    metadata,
    refresh: async () => {
      const token = await acquireOidcToken(metadata.audience, env);
      return exchangeWebIdentity({
        metadata,
        webIdentityToken: token,
        ...(options.stsClient ? { client: options.stsClient } : {}),
      });
    },
  });
  (options.stdout ?? process.stdout).write(
    JSON.stringify(processDocument(credentials)),
  );
}

async function main(): Promise<void> {
  const metadataPath = process.argv[2];
  if (!metadataPath || process.argv.length !== 3) {
    throw new Error("credential helper requires one profile metadata path");
  }
  await runHelper({ metadataPath });
}

if (require.main === module) {
  main().catch((error: unknown) => {
    process.stderr.write(`setup-aws-credential-helper: ${safeError(error)}\n`);
    process.exitCode = 1;
  });
}
