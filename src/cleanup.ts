import * as core from "@actions/core";
import { lstat, realpath, rm } from "node:fs/promises";
import path from "node:path";

export interface CleanupCore {
  getState(name: string): string;
  warning(message: string | Error): void;
}

async function validatedCleanupPath(
  value: string,
  runnerTemp: string,
): Promise<string | undefined> {
  if (!value || !path.isAbsolute(value) || !path.isAbsolute(runnerTemp)) return;
  let parent: string;
  try {
    const parentStat = await lstat(runnerTemp);
    if (parentStat.isSymbolicLink() || !parentStat.isDirectory()) return;
    parent = await realpath(runnerTemp);
  } catch {
    return;
  }
  const relative = path.relative(parent, value);
  if (
    relative.includes(path.sep) ||
    !relative.startsWith("setup-aws-credential-helper-")
  ) {
    return;
  }
  try {
    const stat = await lstat(value);
    if (stat.isSymbolicLink() || !stat.isDirectory()) return;
    return value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return value;
    throw error;
  }
}

export async function runCleanup(
  options: {
    core?: CleanupCore;
    env?: NodeJS.ProcessEnv;
  } = {},
): Promise<void> {
  const actionCore = options.core ?? core;
  const env = options.env ?? process.env;
  try {
    const directory = actionCore.getState("generated-directory");
    const runnerTemp = env.RUNNER_TEMP ?? "";
    const cleanupPath = await validatedCleanupPath(directory, runnerTemp);
    if (!cleanupPath) {
      if (directory)
        actionCore.warning("ignored unsafe generated-directory state");
      return;
    }
    // Best effort only: deletion cannot revoke issued STS credentials or undo
    // environment variables already exported to the job.
    await rm(cleanupPath, { recursive: true, force: true });
  } catch (error) {
    actionCore.warning(
      `could not remove generated credential files: ${
        error instanceof Error ? error.message.slice(0, 300) : "unknown error"
      }`,
    );
  }
}

if (require.main === module) {
  void runCleanup();
}
