import { access, mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { runCleanup } from "../src/cleanup.js";
import { runSetup, type ActionCore } from "../src/setup.js";

const roots: string[] = [];

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function fixture(): Promise<{
  root: string;
  runnerTemp: string;
  actionPath: string;
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), "setup-test-"));
  roots.push(root);
  const runnerTemp = path.join(root, "runner-temp");
  const actionPath = path.join(root, "action");
  await mkdir(path.join(actionPath, "dist"), { recursive: true });
  await mkdir(runnerTemp);
  await writeFile(path.join(actionPath, "dist/helper.cjs"), "");
  return { root, runnerTemp, actionPath };
}

function fakeCore(inputs: Record<string, string>): ActionCore & {
  exports: Map<string, string>;
  states: Map<string, string>;
} {
  const exports = new Map<string, string>();
  const states = new Map<string, string>();
  return {
    exports,
    states,
    getInput: (name) => inputs[name] ?? "",
    exportVariable: (name, value) => exports.set(name, value),
    saveState: (name, value) => states.set(name, value),
    setFailed: vi.fn(),
  };
}

describe("action lifecycle", () => {
  it("exports only profile selection variables and saves one cleanup path", async () => {
    const { runnerTemp, actionPath } = await fixture();
    const actionCore = fakeCore({
      profiles: JSON.stringify([
        {
          name: "one",
          roleArn: "arn:aws:iam::123456789012:role/one",
          region: "eu-west-1",
        },
        {
          name: "two",
          roleArn: "arn:aws:iam::123456789012:role/two",
          region: "us-east-1",
        },
      ]),
      "default-profile": "two",
    });
    const directory = await runSetup({
      core: actionCore,
      env: { RUNNER_TEMP: runnerTemp, GITHUB_RUN_ID: "1" },
      platform: "linux",
      nodePath: process.execPath,
      actionPath,
    });
    expect(Object.fromEntries(actionCore.exports)).toEqual({
      AWS_CONFIG_FILE: path.join(directory, "aws-config"),
      AWS_PROFILE: "two",
      AWS_SDK_LOAD_CONFIG: "1",
    });
    expect(Object.fromEntries(actionCore.states)).toEqual({
      "generated-directory": directory,
    });
  });

  it("cleans up idempotently and ignores unsafe state", async () => {
    const { root, runnerTemp } = await fixture();
    const generated = path.join(runnerTemp, "setup-aws-credential-helper-test");
    await mkdir(generated);
    const warning = vi.fn();
    const cleanupCore = {
      getState: () => generated,
      warning,
    };
    await runCleanup({ core: cleanupCore, env: { RUNNER_TEMP: runnerTemp } });
    await runCleanup({ core: cleanupCore, env: { RUNNER_TEMP: runnerTemp } });
    await expect(access(generated)).rejects.toMatchObject({ code: "ENOENT" });
    expect(warning).not.toHaveBeenCalled();

    await runCleanup({
      core: { getState: () => root, warning },
      env: { RUNNER_TEMP: runnerTemp },
    });
    expect(warning).toHaveBeenCalledWith(
      "ignored unsafe generated-directory state",
    );
    await expect(access(root)).resolves.toBeUndefined();
  });

  it("removes the generated directory after a partial setup failure", async () => {
    const { runnerTemp, actionPath } = await fixture();
    const actionCore = fakeCore({
      profiles: JSON.stringify([
        {
          name: "prod",
          roleArn: "arn:aws:iam::123456789012:role/prod",
          region: "eu-west-1",
        },
      ]),
      "default-profile": "prod",
    });
    actionCore.exportVariable = () => {
      throw new Error("environment file failure");
    };
    await expect(
      runSetup({
        core: actionCore,
        env: { RUNNER_TEMP: runnerTemp },
        platform: "linux",
        nodePath: process.execPath,
        actionPath,
      }),
    ).rejects.toThrow("environment file failure");
    const { readdir } = await import("node:fs/promises");
    expect(await readdir(runnerTemp)).toEqual([]);
  });
});
