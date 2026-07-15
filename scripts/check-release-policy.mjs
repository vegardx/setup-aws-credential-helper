import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";

const forbiddenPackages = [
  "@semantic-release/changelog",
  "@semantic-release/git",
];
const changelogName = /^changelog(?:\.[^.]+)?$/iu;
const ignoredDirectories = new Set([
  ".git",
  "coverage",
  "dist",
  "dist-test",
  "node_modules",
]);
const errors = [];

async function walk(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relativePath = path
      .relative(process.cwd(), path.join(directory, entry.name))
      .split(path.sep)
      .join("/");

    if (entry.isDirectory()) {
      if (!ignoredDirectories.has(entry.name)) {
        await walk(path.join(directory, entry.name));
      }
      continue;
    }

    if (changelogName.test(entry.name)) {
      errors.push(`${relativePath}: repository changelog files are forbidden`);
    }
  }
}

await walk(process.cwd());

const packageJson = JSON.parse(await readFile("package.json", "utf8"));
const packageLock = JSON.parse(await readFile("package-lock.json", "utf8"));
const dependencySections = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
];

for (const packageName of forbiddenPackages) {
  for (const section of dependencySections) {
    if (packageJson[section]?.[packageName] !== undefined) {
      errors.push(`package.json: ${packageName} is forbidden`);
    }
  }
  if (packageLock.packages?.[`node_modules/${packageName}`] !== undefined) {
    errors.push(`package-lock.json: ${packageName} is forbidden`);
  }
}

const releaseConfig = await readFile("release.config.mjs", "utf8");
for (const requiredPlugin of [
  "@semantic-release/commit-analyzer",
  "@semantic-release/release-notes-generator",
  "@semantic-release/github",
]) {
  if (!releaseConfig.includes(requiredPlugin)) {
    errors.push(
      `release.config.mjs: required plugin ${requiredPlugin} is missing`,
    );
  }
}
for (const packageName of forbiddenPackages) {
  const pluginReference = new RegExp(
    `["']${packageName.replace("/", "\\/")}["']`,
    "u",
  );
  if (pluginReference.test(releaseConfig)) {
    errors.push(`release.config.mjs: ${packageName} is forbidden`);
  }
}
if (!releaseConfig.includes('branches: ["main"]')) {
  errors.push("release.config.mjs: releases must be restricted to main");
}
if (!releaseConfig.includes('tagFormat: "v${version}"')) {
  errors.push("release.config.mjs: immutable tags must use vX.Y.Z format");
}
if (/\b(?:cmd|prepareCmd|publishCmd|addChannelCmd)\s*:/u.test(releaseConfig)) {
  errors.push(
    "release.config.mjs: release commits or extra publication are forbidden",
  );
}

const releaseWorkflow = await readFile(".github/workflows/release.yml", "utf8");
if (!/push:\s*\n\s*branches:\s*\n\s*- main/u.test(releaseWorkflow)) {
  errors.push("release.yml: releases must run on pushes to main");
}
if (!/needs:\s*verify/u.test(releaseWorkflow)) {
  errors.push("release.yml: semantic release must depend on verification");
}
if (!/if: needs\.release\.outputs\.released == 'true'/u.test(releaseWorkflow)) {
  errors.push(
    "release.yml: the floating major tag must move only after a real release",
  );
}

const majorTagScript = await readFile("scripts/update-major-tag.sh", "utf8");
for (const requiredGuard of [
  'immutable_tag="v${RELEASE_VERSION}"',
  'if [[ ${release_commit} != "${GITHUB_SHA}" ]]',
  'push --force "${remote_url}" "refs/tags/${major_tag}:refs/tags/${major_tag}"',
]) {
  if (!majorTagScript.includes(requiredGuard)) {
    errors.push(
      `scripts/update-major-tag.sh: missing release guard ${requiredGuard}`,
    );
  }
}

if ((await stat("scripts/update-major-tag.sh")).mode & 0o111) {
  // The release workflow invokes this script directly.
} else {
  errors.push("scripts/update-major-tag.sh: script must remain executable");
}

if (errors.length > 0) {
  console.error(errors.join("\n"));
  process.exitCode = 1;
} else {
  console.log("GitHub-Releases-only semantic release policy verified.");
}
