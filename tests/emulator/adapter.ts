import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const MAX_DIAGNOSTIC_CHARS = 8_000;

export interface EmulatorImageDetails {
  image: string;
  imageId: string;
  digest: string;
  version: string;
}

export interface EmulatorRun {
  endpoint: string;
  image: EmulatorImageDetails;
  startupMs: number;
  diagnostics(): Promise<string>;
  stop(): Promise<{ cleanupMs: number; removed: boolean }>;
}

export interface EmulatorAdapter {
  readonly name: string;
  readonly image: string;
  readonly containerPort: number;
  readonly endpointQuirks: readonly string[];
  start(): Promise<EmulatorRun>;
}

interface ImageInspect {
  Id?: string;
  RepoDigests?: string[];
  Config?: { Labels?: Record<string, string> };
}

interface ContainerInspect {
  NetworkSettings?: {
    Ports?: Record<
      string,
      Array<{ HostIp?: string; HostPort?: string }> | null
    >;
  };
}

export function sanitizeDiagnostics(value: string): string {
  return value
    .replace(
      /(authorization\s*[:=]\s*(?:bearer\s+)?)[^\s,;]+/gi,
      "$1[redacted]",
    )
    .replace(
      /((?:secretaccesskey|sessiontoken|webidentitytoken)\s*[:=]\s*)[^\s,;<]+/gi,
      "$1[redacted]",
    )
    .slice(-MAX_DIAGNOSTIC_CHARS);
}

async function docker(
  args: string[],
  options: { timeout?: number } = {},
): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync("docker", args, {
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
    timeout: options.timeout ?? 60_000,
  });
}

async function pullAndInspect(image: string): Promise<{
  imageId: string;
  digest: string;
  labels: Record<string, string>;
}> {
  await docker(["pull", image], { timeout: 300_000 });
  const { stdout } = await docker(["image", "inspect", image]);
  const parsed = JSON.parse(stdout) as ImageInspect[];
  const inspected = parsed[0];
  const imageId = inspected?.Id;
  const digest = inspected?.RepoDigests?.[0];
  if (!imageId || !digest) {
    throw new Error(
      `Docker did not report an image ID and digest for ${image}`,
    );
  }
  return { imageId, digest, labels: inspected.Config?.Labels ?? {} };
}

async function mappedEndpoint(
  containerName: string,
  containerPort: number,
): Promise<string> {
  const { stdout } = await docker(["container", "inspect", containerName]);
  const parsed = JSON.parse(stdout) as ContainerInspect[];
  const mappings = parsed[0]?.NetworkSettings?.Ports?.[`${containerPort}/tcp`];
  const mapping = mappings?.[0];
  if (
    mapping?.HostIp !== "127.0.0.1" ||
    !mapping.HostPort ||
    !/^\d{1,5}$/.test(mapping.HostPort)
  ) {
    throw new Error(
      "Docker did not create the required random loopback port mapping",
    );
  }
  return `http://127.0.0.1:${mapping.HostPort}`;
}

async function waitUntilReady(
  readinessUrl: string,
  isReady: (response: Response, body: string) => boolean,
): Promise<string> {
  const deadline = Date.now() + 45_000;
  let lastStatus = "no response";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(readinessUrl, {
        signal: AbortSignal.timeout(2_000),
      });
      const body = await response.text();
      lastStatus = `HTTP ${response.status}`;
      if (isReady(response, body)) return body;
    } catch (error) {
      lastStatus = error instanceof Error ? error.message : "request failed";
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Emulator readiness timed out (${lastStatus})`);
}

export interface DockerAdapterOptions {
  name: string;
  image: string;
  containerPort: number;
  readinessPath: string;
  isReady: (response: Response, body: string) => boolean;
  version: (context: {
    body: string;
    labels: Record<string, string>;
    containerName: string;
  }) => Promise<string>;
  endpointQuirks: readonly string[];
}

export function createDockerAdapter(
  options: DockerAdapterOptions,
): EmulatorAdapter {
  return {
    name: options.name,
    image: options.image,
    containerPort: options.containerPort,
    endpointQuirks: options.endpointQuirks,
    async start(): Promise<EmulatorRun> {
      const startedAt = performance.now();
      const resolved = await pullAndInspect(options.image);
      const containerName = `credential-helper-${options.name}-${process.pid}-${randomBytes(5).toString("hex")}`;
      let created = false;
      try {
        await docker([
          "run",
          "--detach",
          "--name",
          containerName,
          "--publish",
          `127.0.0.1::${options.containerPort}`,
          "--label",
          "io.github.vegardx.setup-aws-credential-helper.test=true",
          options.image,
        ]);
        created = true;
        const endpoint = await mappedEndpoint(
          containerName,
          options.containerPort,
        );
        const body = await waitUntilReady(
          `${endpoint}${options.readinessPath}`,
          options.isReady,
        );
        const version = await options.version({
          body,
          labels: resolved.labels,
          containerName,
        });
        let stopped = false;
        return {
          endpoint,
          image: { ...resolved, image: options.image, version },
          startupMs: Math.round(performance.now() - startedAt),
          diagnostics: async () => {
            const result = await docker([
              "logs",
              "--tail",
              "200",
              containerName,
            ]);
            return sanitizeDiagnostics(`${result.stdout}${result.stderr}`);
          },
          stop: async () => {
            const cleanupStartedAt = performance.now();
            if (!stopped) {
              stopped = true;
              await docker(["rm", "--force", containerName]);
            }
            try {
              await docker(["container", "inspect", containerName]);
              return {
                cleanupMs: Math.round(performance.now() - cleanupStartedAt),
                removed: false,
              };
            } catch {
              return {
                cleanupMs: Math.round(performance.now() - cleanupStartedAt),
                removed: true,
              };
            }
          },
        };
      } catch (error) {
        let diagnostics = "";
        if (created) {
          try {
            const result = await docker([
              "logs",
              "--tail",
              "200",
              containerName,
            ]);
            diagnostics = sanitizeDiagnostics(
              `${result.stdout}${result.stderr}`,
            );
          } catch {
            // The container may already have disappeared.
          }
          try {
            await docker(["rm", "--force", containerName]);
          } catch {
            // Preserve the original startup failure.
          }
        }
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(
          `Could not start ${options.name}: ${message}${diagnostics ? `\n${diagnostics}` : ""}`,
          { cause: error },
        );
      }
    },
  };
}

export async function containerCommand(
  containerName: string,
  args: string[],
): Promise<string> {
  const result = await docker(["exec", containerName, ...args]);
  return result.stdout.trim();
}
