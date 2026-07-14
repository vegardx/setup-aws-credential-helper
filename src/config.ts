import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import path from "node:path";

import {
  PROFILE_METADATA_VERSION,
  type Profile,
  type ProfileMetadata,
} from "./types.js";
import {
  buildJobIdentity,
  buildSessionName,
  stsEndpointForRegion,
} from "./input.js";

const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;

export async function validateRunnerTemp(runnerTemp: string): Promise<string> {
  if (!path.isAbsolute(runnerTemp) || runnerTemp.includes("\0")) {
    throw new Error("RUNNER_TEMP must be an absolute path");
  }
  const stat = await lstat(runnerTemp);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error("RUNNER_TEMP must be a real directory, not a symlink");
  }
  return realpath(runnerTemp);
}

export async function createPrivateDirectory(
  runnerTemp: string,
): Promise<string> {
  const parent = await validateRunnerTemp(runnerTemp);
  const directory = await mkdtemp(
    path.join(parent, "setup-aws-credential-helper-"),
  );
  await chmod(directory, PRIVATE_DIRECTORY_MODE);
  const stat = await lstat(directory);
  if (
    stat.isSymbolicLink() ||
    !stat.isDirectory() ||
    (stat.mode & 0o777) !== 0o700
  ) {
    await rm(directory, { recursive: true, force: true });
    throw new Error("could not create a private action directory");
  }
  return directory;
}

function quoteCredentialProcessArgument(value: string): string {
  if (!path.isAbsolute(value) || /[\p{Cc}]/u.test(value)) {
    throw new Error("credential_process paths must be safe absolute paths");
  }
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

async function writePrivateJson(
  filePath: string,
  value: unknown,
): Promise<void> {
  await writeFile(filePath, `${JSON.stringify(value)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: PRIVATE_FILE_MODE,
  });
  await chmod(filePath, PRIVATE_FILE_MODE);
}

export interface GeneratedConfiguration {
  configPath: string;
  cacheRoot: string;
  metadataPaths: string[];
}

export async function generateConfiguration(options: {
  directory: string;
  profiles: Profile[];
  helperPath: string;
  nodePath: string;
  env: NodeJS.ProcessEnv;
}): Promise<GeneratedConfiguration> {
  const { directory, profiles, helperPath, nodePath, env } = options;
  const metadataDirectory = path.join(directory, "profiles");
  const cacheRoot = path.join(directory, "cache");
  await mkdir(metadataDirectory, { mode: PRIVATE_DIRECTORY_MODE });
  await mkdir(cacheRoot, { mode: PRIVATE_DIRECTORY_MODE });

  const configLines: string[] = [];
  const metadataPaths: string[] = [];
  for (const profile of profiles) {
    const metadataPath = path.join(metadataDirectory, `${profile.name}.json`);
    const metadata: ProfileMetadata = {
      version: PROFILE_METADATA_VERSION,
      ...profile,
      sessionName: buildSessionName(profile.name, env),
      jobIdentity: buildJobIdentity(env),
      stsEndpoint: stsEndpointForRegion(profile.partition, profile.region),
      cacheRoot,
    };
    await writePrivateJson(metadataPath, metadata);
    metadataPaths.push(metadataPath);

    const command = [nodePath, helperPath, metadataPath]
      .map(quoteCredentialProcessArgument)
      .join(" ");
    configLines.push(
      `[profile ${profile.name}]`,
      `region = ${profile.region}`,
      `credential_process = ${command}`,
      "",
    );
  }

  const configPath = path.join(directory, "aws-config");
  const temporaryPath = path.join(directory, ".aws-config.tmp");
  await writeFile(temporaryPath, `${configLines.join("\n")}\n`, {
    encoding: "utf8",
    flag: fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL,
    mode: PRIVATE_FILE_MODE,
  });
  await chmod(temporaryPath, PRIVATE_FILE_MODE);
  await rename(temporaryPath, configPath);
  return { configPath, cacheRoot, metadataPaths };
}
