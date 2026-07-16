import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const helperPath = path.resolve("dist/helper.cjs");

function invokeHelper(metadataPath, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [helperPath, metadataPath], {
      env: { ...process.env, ...env },
    });
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("production helper isolation check timed out"));
    }, 5_000);
    child.stdout.setEncoding("utf8").on("data", (chunk) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk) => (stderr += chunk));
    child.once("error", reject);
    child.once("close", (code) => {
      clearTimeout(timeout);
      resolve({ code, stdout, stderr });
    });
  });
}

function metadata(cacheRoot, stsEndpoint, roleDurationSeconds = 2) {
  return {
    version: 1,
    name: "production-isolation",
    roleArn: "arn:aws:iam::123456789012:role/production-isolation",
    region: "us-east-1",
    audience: "sts.amazonaws.com",
    roleDurationSeconds,
    partition: "aws",
    sessionName: "gha-1-1-production-isolation",
    jobIdentity: {
      serverUrl: "https://github.com",
      repository: "owner/repository",
      workflow: "verify",
      workflowRef: "",
      job: "verify",
      runId: "1",
      runAttempt: "1",
      ref: "refs/heads/main",
    },
    stsEndpoint,
    cacheRoot,
  };
}

async function verifyProductionEndpointIsolation() {
  const root = await mkdtemp(path.join(os.tmpdir(), "verify-helper-dist-"));
  const cacheRoot = path.join(root, "cache");
  await mkdir(cacheRoot, { mode: 0o700 });
  let requests = 0;
  const server = createServer((_request, response) => {
    requests += 1;
    response.statusCode = 500;
    response.end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("could not bind production isolation test server");
  }
  const loopback = `http://127.0.0.1:${address.port}/`;
  const runtimeOverrides = {
    ACTIONS_ID_TOKEN_REQUEST_URL: loopback,
    ACTIONS_ID_TOKEN_REQUEST_TOKEN: "plausible-runtime-bearer",
    AWS_ENDPOINT_URL_STS: loopback,
    LOCALSTACK_ENDPOINT: loopback,
    CREDENTIAL_HELPER_TEST_ALLOW_HTTP: "1",
    TEST_ALLOW_LOCAL_HTTP: "1",
    STS_ENDPOINT: loopback,
  };
  try {
    const loopbackStsPath = path.join(root, "loopback-sts.json");
    await writeFile(
      loopbackStsPath,
      JSON.stringify(metadata(cacheRoot, loopback)),
      { mode: 0o600 },
    );
    const stsResult = await invokeHelper(loopbackStsPath, runtimeOverrides);
    if (stsResult.code === 0 || stsResult.stdout !== "" || requests !== 0) {
      throw new Error(
        "production helper accepted or requested a test-only loopback STS endpoint",
      );
    }

    const loopbackOidcPath = path.join(root, "loopback-oidc.json");
    await writeFile(
      loopbackOidcPath,
      JSON.stringify(
        metadata(cacheRoot, "https://sts.us-east-1.amazonaws.com"),
      ),
      { mode: 0o600 },
    );
    const oidcResult = await invokeHelper(loopbackOidcPath, runtimeOverrides);
    if (oidcResult.code === 0 || oidcResult.stdout !== "" || requests !== 0) {
      throw new Error(
        "production helper accepted or requested a runtime loopback OIDC endpoint",
      );
    }
  } finally {
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await rm(root, { recursive: true, force: true });
  }
}

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

const [helper, actionMetadata] = await Promise.all([
  readFile("dist/helper.cjs", "utf8"),
  readFile("action.yml", "utf8"),
]);
const forbiddenHelper = [
  ["@actions/core", "GitHub Actions toolkit dependency"],
  ["CREDENTIAL_HELPER_TEST_ALLOW_HTTP", "legacy local HTTP runtime hook"],
  ["TEST_ALLOW_LOCAL_HTTP", "local HTTP runtime hook"],
  ["LOCALSTACK_ENDPOINT", "integration endpoint control"],
  ["dist-test", "test distribution reference"],
];
const forbiddenActionMetadata = [
  ["dist-test", "test distribution reference"],
  ["LOCALSTACK_ENDPOINT", "integration endpoint control"],
  ["TEST_ALLOW_LOCAL_HTTP", "local HTTP runtime hook"],
];

for (const [needle, description] of forbiddenHelper) {
  if (helper.includes(needle)) {
    console.error(
      `Production helper bundle contains forbidden ${description}.`,
    );
    failed = true;
  }
}
for (const [needle, description] of forbiddenActionMetadata) {
  if (actionMetadata.includes(needle)) {
    console.error(`action.yml contains forbidden ${description}.`);
    failed = true;
  }
}

try {
  await verifyProductionEndpointIsolation();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  failed = true;
}

if (failed) {
  process.exitCode = 1;
} else {
  console.log("Committed bundles and production helper isolation verified.");
}
