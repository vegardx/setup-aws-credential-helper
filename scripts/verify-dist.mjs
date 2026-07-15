import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";

const diff = spawnSync("git", ["diff", "--exit-code", "--", "dist/"], {
  encoding: "utf8",
});
const status = spawnSync(
  "git",
  ["status", "--porcelain", "--untracked-files=all", "--", "dist/"],
  { encoding: "utf8" },
);
let failed = false;
if (diff.status !== 0 || status.status !== 0 || status.stdout.length > 0) {
  process.stdout.write(diff.stdout);
  process.stdout.write(status.stdout);
  process.stderr.write(diff.stderr);
  process.stderr.write(status.stderr);
  console.error(
    "Committed dist/ bundles are not reproducible from the source.",
  );
  failed = true;
}

const helper = await readFile("dist/helper.cjs", "utf8");
const forbidden = [
  ["@actions/core", "GitHub Actions toolkit dependency"],
  ["CREDENTIAL_HELPER_TEST_ALLOW_HTTP", "local HTTP test hook"],
];

for (const [needle, description] of forbidden) {
  if (helper.includes(needle)) {
    console.error(
      `Production helper bundle contains forbidden ${description}.`,
    );
    failed = true;
  }
}

if (failed) {
  process.exitCode = 1;
} else {
  console.log("Committed bundles and production helper isolation verified.");
}
