import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

const workflowDirectory = path.resolve(".github/workflows");
const files = (await readdir(workflowDirectory))
  .filter((file) => file.endsWith(".yml") || file.endsWith(".yaml"))
  .sort();

if (files.length === 0) {
  throw new Error("No workflow files found");
}

const errors = [];
const shaPinnedUse =
  /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_./-]+@[a-f0-9]{40}(?:\s+#.*)?$/;
const digestPinnedDockerUse =
  /^docker:\/\/[^\s@]+:[^\s@]+@sha256:[a-f0-9]{64}(?:\s+#.*)?$/;

for (const file of files) {
  const relativePath = path.posix.join(".github/workflows", file);
  const content = await readFile(path.join(workflowDirectory, file), "utf8");
  const lines = content.split(/\r?\n/u);

  if (!/^permissions:\n {2}contents: read$/mu.test(content)) {
    errors.push(
      `${relativePath}: top-level permissions must be contents: read`,
    );
  }
  for (const [index, line] of lines.entries()) {
    if (/^\s*permissions:\s*(?:write-all|read-all|\{)/u.test(line)) {
      errors.push(
        `${relativePath}:${index + 1}: scalar and inline permissions are forbidden`,
      );
    }
    if (/\bid-token:\s*write\b/u.test(line)) {
      errors.push(
        `${relativePath}:${index + 1}: id-token: write is forbidden in repository workflows`,
      );
    }
    const writePermission = /^\s{4,}([A-Za-z-]+):\s*write(?:\s+#.*)?$/u.exec(
      line,
    );
    if (!writePermission) continue;
    const permission = writePermission[1];
    if (file !== "release.yml" || permission !== "contents") {
      errors.push(
        `${relativePath}:${index + 1}: only release jobs may request contents: write`,
      );
    }
  }
  if (file !== "release.yml" && /\bsecrets\s*\./u.test(content)) {
    errors.push(
      `${relativePath}: non-release workflows must not consume secrets`,
    );
  }
  if (file === "offline-integration.yml") {
    if (!/^ {4}name: Offline integration$/mu.test(content)) {
      errors.push(`${relativePath}: stable aggregate job name is missing`);
    }
    if (!content.includes("ubuntu-24.04-arm")) {
      errors.push(`${relativePath}: required native arm64 runner is missing`);
    }
  }
  if (file === "ubuntu-26-compatibility.yml") {
    if (
      !content.includes("ubuntu-26.04") ||
      !content.includes("ubuntu-26.04-arm")
    ) {
      errors.push(
        `${relativePath}: both Ubuntu 26 preview architectures are required`,
      );
    }
  }
  if (/\bpull_request_target\s*:/u.test(content)) {
    errors.push(`${relativePath}: pull_request_target is forbidden`);
  }

  lines.forEach((line, index) => {
    const match = /^\s*-?\s*uses:\s*(\S.*)$/u.exec(line);
    if (!match) return;
    const reference = match[1].trim();
    if (
      reference.startsWith("./") ||
      shaPinnedUse.test(reference) ||
      digestPinnedDockerUse.test(reference)
    ) {
      return;
    }
    errors.push(
      `${relativePath}:${index + 1}: uses reference must be pinned to a full commit SHA or container digest: ${reference}`,
    );
  });

  const checkoutLines = lines
    .map((line, index) => ({ line, index }))
    .filter(({ line }) => /uses:\s*actions\/checkout@/u.test(line));
  for (const { index } of checkoutLines) {
    const step = lines.slice(index, index + 8).join("\n");
    if (!/persist-credentials:\s*false/u.test(step)) {
      errors.push(
        `${relativePath}:${index + 1}: actions/checkout must disable persisted credentials`,
      );
    }
  }
}

if (errors.length > 0) {
  console.error(errors.join("\n"));
  process.exitCode = 1;
} else {
  console.log(`Workflow policy passed for ${files.length} workflow files.`);
}
