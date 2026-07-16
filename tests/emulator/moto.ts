import { createDockerAdapter, type EmulatorAdapter } from "./adapter.js";

export function motoAdapter(): EmulatorAdapter {
  return createDockerAdapter({
    name: "moto",
    image: "motoserver/moto:latest",
    containerPort: 5000,
    readinessPath: "/",
    isReady: (response, body) =>
      response.ok && body.includes("ListAllMyBucketsResult"),
    async version({ containerName }) {
      const { execFile } = await import("node:child_process");
      const { promisify } = await import("node:util");
      const result = await promisify(execFile)(
        "docker",
        [
          "exec",
          containerName,
          "python",
          "-c",
          "import importlib.metadata; print(importlib.metadata.version('moto'))",
        ],
        { encoding: "utf8", timeout: 10_000 },
      );
      return result.stdout.trim() || "unknown";
    },
    endpointQuirks: [
      "Use the Moto server root for every service endpoint.",
      "Force path-style S3 addressing on the random loopback host.",
    ],
  });
}
