import { createDockerAdapter, type EmulatorAdapter } from "./adapter.js";

interface FlociHealth {
  version?: unknown;
  services?: Record<string, unknown>;
}

export function flociAdapter(): EmulatorAdapter {
  return createDockerAdapter({
    name: "floci",
    image: "floci/floci:latest",
    containerPort: 4566,
    readinessPath: "/_localstack/health",
    isReady(response, body) {
      if (!response.ok) return false;
      try {
        const health = JSON.parse(body) as FlociHealth;
        return ["sts", "s3", "sqs", "cloudformation"].every(
          (service) => health.services?.[service] === "running",
        );
      } catch {
        return false;
      }
    },
    async version({ body, labels }) {
      const health = JSON.parse(body) as FlociHealth;
      const version =
        health.version ?? labels["org.opencontainers.image.version"];
      return typeof version === "string" && version ? version : "unknown";
    },
    endpointQuirks: [
      "Use one edge endpoint for STS, S3, SQS, and CloudFormation.",
      "Force path-style S3 addressing on the random loopback host.",
    ],
  });
}
