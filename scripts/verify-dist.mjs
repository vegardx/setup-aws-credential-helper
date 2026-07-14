import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";

const diff = spawnSync("git", ["diff", "--exit-code", "--", "dist/"], {
  encoding: "utf8",
});
if (diff.status !== 0) {
  process.stdout.write(diff.stdout);
  process.stderr.write(diff.stderr);
  console.error(
    "Committed dist/ bundles are not reproducible from the source.",
  );
  process.exitCode = 1;
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
    process.exitCode = 1;
  }
}

if (process.exitCode !== 1) {
  console.log("Committed bundles and production helper isolation verified.");
}
