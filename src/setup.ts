import * as core from "@actions/core";
import { access, rm } from "node:fs/promises";
import path from "node:path";

import { createPrivateDirectory, generateConfiguration } from "./config.js";
import {
  assertSupportedRuntime,
  findCredentialEnvironmentConflicts,
  parseProfiles,
  validateDefaultProfile,
} from "./input.js";

export interface ActionCore {
  exportVariable(name: string, value: string): void;
  getInput(name: string, options?: { required?: boolean }): string;
  saveState(name: string, value: string): void;
  setFailed(message: string | Error): void;
}

export async function runSetup(
  options: {
    core?: ActionCore;
    env?: NodeJS.ProcessEnv;
    platform?: NodeJS.Platform;
    nodePath?: string;
    actionPath?: string;
  } = {},
): Promise<string> {
  const actionCore = options.core ?? core;
  const env = options.env ?? process.env;
  assertSupportedRuntime(options.platform ?? process.platform);
  const conflicts = findCredentialEnvironmentConflicts(env);
  if (conflicts.length > 0) {
    throw new Error(
      `competing AWS credential environment variables are set: ${conflicts.join(", ")}`,
    );
  }

  const profiles = parseProfiles(
    actionCore.getInput("profiles", { required: true }),
  );
  const defaultProfile = validateDefaultProfile(
    actionCore.getInput("default-profile", { required: true }),
    profiles,
  );
  const runnerTemp = env.RUNNER_TEMP;
  if (!runnerTemp) throw new Error("RUNNER_TEMP is required");
  const actionPath = options.actionPath ?? env.GITHUB_ACTION_PATH ?? __dirname;
  const helperPath = path.resolve(actionPath, "dist/helper.cjs");
  const nodePath = path.resolve(options.nodePath ?? process.execPath);
  if (!path.isAbsolute(actionPath))
    throw new Error("GITHUB_ACTION_PATH must be absolute");
  await access(helperPath);
  await access(nodePath);

  const directory = await createPrivateDirectory(runnerTemp);
  try {
    const generated = await generateConfiguration({
      directory,
      profiles,
      helperPath,
      nodePath,
      env,
    });
    actionCore.exportVariable("AWS_CONFIG_FILE", generated.configPath);
    actionCore.exportVariable("AWS_PROFILE", defaultProfile);
    actionCore.exportVariable("AWS_SDK_LOAD_CONFIG", "1");
    actionCore.saveState("generated-directory", directory);
    return directory;
  } catch (error) {
    await rm(directory, { recursive: true, force: true }).catch(
      () => undefined,
    );
    throw error;
  }
}

if (require.main === module) {
  runSetup().catch((error: unknown) => {
    core.setFailed(error instanceof Error ? error : new Error("setup failed"));
  });
}
