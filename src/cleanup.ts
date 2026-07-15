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
): Promise<string | null | undefined> {
  if (!value) return;
  if (!path.isAbsolute(value) || !path.isAbsolute(runnerTemp)) return null;
  let parent: string;
  try {
    const parentStat = await lstat(runnerTemp);
    if (parentStat.isSymbolicLink() || !parentStat.isDirectory()) return null;
    parent = await realpath(runnerTemp);
  } catch {
    return null;
  }
  let candidate: string;
  try {
    const stat = await lstat(value);
    if (stat.isSymbolicLink() || !stat.isDirectory()) return null;
    candidate = await realpath(value);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  const relative = path.relative(parent, candidate);
  if (
    relative.includes(path.sep) ||
    !relative.startsWith("setup-aws-credential-helper-")
  ) {
    return null;
  }
  return candidate;
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
    if (cleanupPath === null) {
      actionCore.warning("ignored unsafe generated-directory state");
      return;
    }
    if (!cleanupPath) return;
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
