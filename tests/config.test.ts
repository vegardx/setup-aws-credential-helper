import { mkdtemp, readFile, stat, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  createPrivateDirectory,
  generateConfiguration,
  validateRunnerTemp,
} from "../src/config.js";
import type { Profile } from "../src/types.js";

const temporary: string[] = [];
const profile: Profile = {
  name: "prod",
  roleArn: "arn:aws:iam::123456789012:role/prod",
  region: "eu-west-1",
  audience: "sts.amazonaws.com",
  roleDurationSeconds: 3600,
  partition: "aws",
};

afterEach(async () => {
  await Promise.all(
    temporary.splice(0).map(async (directory) => {
      const { rm } = await import("node:fs/promises");
      await rm(directory, { recursive: true, force: true });
    }),
  );
});

describe("AWS config generation", () => {
  it("writes private metadata and quoted absolute credential_process paths", async () => {
    const parent = await mkdtemp(path.join(os.tmpdir(), "config-test-"));
    temporary.push(parent);
    const directory = await createPrivateDirectory(parent);
    const generated = await generateConfiguration({
      directory,
      profiles: [profile],
      nodePath: "/opt/action node/node",
      helperPath: "/opt/action path/dist/helper.cjs",
      env: {
        GITHUB_RUN_ID: "42",
        GITHUB_RUN_ATTEMPT: "2",
        GITHUB_REPOSITORY: "owner/repo",
      },
    });

    expect((await stat(directory)).mode & 0o777).toBe(0o700);
    expect((await stat(generated.configPath)).mode & 0o777).toBe(0o600);
    expect((await stat(generated.metadataPaths[0]!)).mode & 0o777).toBe(0o600);
    expect(await readFile(generated.configPath, "utf8")).toBe(
      "[profile prod]\n" +
        "region = eu-west-1\n" +
        'credential_process = "/opt/action node/node" "/opt/action path/dist/helper.cjs" "' +
        generated.metadataPaths[0] +
        '"\n\n',
    );
    const metadata = JSON.parse(
      await readFile(generated.metadataPaths[0]!, "utf8"),
    ) as { sessionName: string; cacheRoot: string };
    expect(metadata.sessionName).toBe("gha-42-2-prod");
    expect(metadata.cacheRoot).toBe(generated.cacheRoot);
  });

  it("rejects a symlinked runner temp and relative paths", async () => {
    const parent = await mkdtemp(path.join(os.tmpdir(), "config-link-"));
    temporary.push(parent);
    const target = path.join(parent, "target");
    const link = path.join(parent, "link");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(target);
    await symlink(target, link);
    await expect(validateRunnerTemp(link)).rejects.toThrow("not a symlink");
    await expect(validateRunnerTemp("relative")).rejects.toThrow("absolute");
  });
});
