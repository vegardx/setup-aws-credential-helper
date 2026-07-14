import type { AwsPartition, JobIdentity, Profile } from "./types.js";

const PROFILE_KEYS = new Set([
  "name",
  "roleArn",
  "region",
  "audience",
  "roleDurationSeconds",
]);
const PROFILE_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const REGION =
  /^(?:[a-z]{2}(?:-gov|-iso)?|us-isob|eu-isoe|us-isof)-[a-z]+-\d+$/;
const ARN = /^arn:([^:]+):iam::(\d{12}):role\/(.+)$/;
const CONTROL_OR_NEWLINE = /[\p{Cc}]/u;
const ROLE_PATH = /^[\w+=,.@/-]+$/;
const AUDIENCE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,254}$/;

const PARTITION_REGION_PREFIX: Record<AwsPartition, RegExp> = {
  aws: /^(?!cn-|us-gov-|us-iso(?:-[bef])?-)/,
  "aws-cn": /^cn-/,
  "aws-us-gov": /^us-gov-/,
  "aws-iso": /^us-iso-/,
  "aws-iso-b": /^us-isob-/,
  "aws-iso-e": /^eu-isoe-/,
  "aws-iso-f": /^us-isof-/,
};

function record(value: unknown, context: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${context} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requiredString(
  value: unknown,
  field: string,
  maxLength = 1024,
): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maxLength ||
    CONTROL_OR_NEWLINE.test(value) ||
    value !== value.trim()
  ) {
    throw new Error(`${field} must be a non-empty safe string`);
  }
  return value;
}

export function partitionForRegion(region: string): AwsPartition {
  if (region.startsWith("cn-")) return "aws-cn";
  if (region.startsWith("us-gov-")) return "aws-us-gov";
  if (region.startsWith("us-isob-")) return "aws-iso-b";
  if (region.startsWith("us-iso-")) return "aws-iso";
  if (region.startsWith("eu-isoe-")) return "aws-iso-e";
  if (region.startsWith("us-isof-")) return "aws-iso-f";
  return "aws";
}

const PARTITION_ENDPOINT_SUFFIX: Record<AwsPartition, string> = {
  aws: "amazonaws.com",
  "aws-cn": "amazonaws.com.cn",
  "aws-us-gov": "amazonaws.com",
  "aws-iso": "c2s.ic.gov",
  "aws-iso-b": "sc2s.sgov.gov",
  "aws-iso-e": "cloud.adc-e.uk",
  "aws-iso-f": "csp.hci.ic.gov",
};

export function stsEndpointForRegion(
  partition: AwsPartition,
  region: string,
): string {
  return `https://sts.${region}.${PARTITION_ENDPOINT_SUFFIX[partition]}`;
}

function parseProfile(value: unknown, index: number): Profile {
  const input = record(value, `profiles[${index}]`);
  for (const key of Object.keys(input)) {
    if (!PROFILE_KEYS.has(key)) {
      throw new Error(`profiles[${index}] contains unknown key ${key}`);
    }
  }

  const name = requiredString(input.name, `profiles[${index}].name`, 64);
  if (!PROFILE_NAME.test(name)) {
    throw new Error(`profiles[${index}].name is not a safe named profile`);
  }
  if (name === "default") {
    throw new Error(`profiles[${index}].name must not be "default"`);
  }

  const roleArn = requiredString(
    input.roleArn,
    `profiles[${index}].roleArn`,
    2048,
  );
  const arnMatch = ARN.exec(roleArn);
  if (!arnMatch) {
    throw new Error(`profiles[${index}].roleArn must be an IAM role ARN`);
  }
  const partition = arnMatch[1] as AwsPartition;
  if (!(partition in PARTITION_REGION_PREFIX)) {
    throw new Error(`profiles[${index}].roleArn uses an unsupported partition`);
  }
  const rolePath = arnMatch[3];
  if (!rolePath || rolePath.length > 512 || !ROLE_PATH.test(rolePath)) {
    throw new Error(`profiles[${index}].roleArn has an unsafe role path`);
  }

  const region = requiredString(input.region, `profiles[${index}].region`, 64);
  if (
    !REGION.test(region) ||
    !PARTITION_REGION_PREFIX[partition].test(region)
  ) {
    throw new Error(
      `profiles[${index}].region is malformed or incompatible with the role partition`,
    );
  }
  if (partitionForRegion(region) !== partition) {
    throw new Error(`profiles[${index}] role partition does not match region`);
  }

  const audience =
    input.audience === undefined
      ? "sts.amazonaws.com"
      : requiredString(input.audience, `profiles[${index}].audience`, 255);
  if (!AUDIENCE.test(audience)) {
    throw new Error(`profiles[${index}].audience is unsafe`);
  }

  const roleDurationSeconds = input.roleDurationSeconds ?? 3600;
  if (
    typeof roleDurationSeconds !== "number" ||
    !Number.isInteger(roleDurationSeconds) ||
    roleDurationSeconds < 900 ||
    roleDurationSeconds > 43_200
  ) {
    throw new Error(
      `profiles[${index}].roleDurationSeconds must be an integer from 900 through 43200`,
    );
  }

  return {
    name,
    roleArn,
    region,
    audience,
    roleDurationSeconds,
    partition,
  };
}

export interface EffectiveProfileValidationInput {
  name: unknown;
  roleArn: unknown;
  region: unknown;
  audience: unknown;
  roleDurationSeconds: unknown;
  partition: unknown;
  sessionName: unknown;
  stsEndpoint: unknown;
}

export function isValidEffectiveProfile(
  value: EffectiveProfileValidationInput,
): boolean {
  if (
    typeof value.name !== "string" ||
    !PROFILE_NAME.test(value.name) ||
    value.name === "default" ||
    typeof value.roleArn !== "string" ||
    typeof value.region !== "string" ||
    typeof value.audience !== "string" ||
    !AUDIENCE.test(value.audience) ||
    typeof value.roleDurationSeconds !== "number" ||
    !Number.isInteger(value.roleDurationSeconds) ||
    value.roleDurationSeconds < 900 ||
    value.roleDurationSeconds > 43_200 ||
    typeof value.sessionName !== "string" ||
    !/^[\w+=,.@-]{2,64}$/.test(value.sessionName) ||
    typeof value.stsEndpoint !== "string"
  ) {
    return false;
  }
  const match = ARN.exec(value.roleArn);
  if (!match || !(match[1]! in PARTITION_REGION_PREFIX)) return false;
  const partition = match[1] as AwsPartition;
  const rolePath = match[3];
  return (
    value.partition === partition &&
    Boolean(rolePath && rolePath.length <= 512 && ROLE_PATH.test(rolePath)) &&
    REGION.test(value.region) &&
    PARTITION_REGION_PREFIX[partition].test(value.region) &&
    partitionForRegion(value.region) === partition &&
    value.stsEndpoint === stsEndpointForRegion(partition, value.region)
  );
}

export function parseProfiles(raw: string): Profile[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new Error("profiles must be valid JSON");
  }
  if (!Array.isArray(parsed) || parsed.length === 0 || parsed.length > 50) {
    throw new Error(
      "profiles must be a non-empty JSON array with at most 50 entries",
    );
  }
  const profiles = parsed.map(parseProfile);
  const names = new Set<string>();
  for (const profile of profiles) {
    if (names.has(profile.name)) {
      throw new Error(`duplicate profile name: ${profile.name}`);
    }
    names.add(profile.name);
  }
  return profiles;
}

export function validateDefaultProfile(
  raw: string,
  profiles: Profile[],
): string {
  const value = requiredString(raw, "default-profile", 64);
  if (!profiles.some((profile) => profile.name === value)) {
    throw new Error("default-profile must name one of the configured profiles");
  }
  return value;
}

export function assertSupportedRuntime(platform = process.platform): void {
  if (platform !== "linux") {
    throw new Error(
      "setup-aws-credential-helper v1 supports Linux runners only",
    );
  }
}

const CONFLICTING_CREDENTIAL_VARIABLES = [
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "AWS_SECURITY_TOKEN",
  "AWS_WEB_IDENTITY_TOKEN_FILE",
  "AWS_ROLE_ARN",
  "AWS_ROLE_SESSION_NAME",
  "AWS_CONTAINER_CREDENTIALS_FULL_URI",
  "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI",
  "AWS_CONTAINER_AUTHORIZATION_TOKEN",
  "AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE",
] as const;

export function findCredentialEnvironmentConflicts(
  env: NodeJS.ProcessEnv,
): string[] {
  return CONFLICTING_CREDENTIAL_VARIABLES.filter((name) => Boolean(env[name]));
}

function numericOrFallback(
  value: string | undefined,
  fallback: string,
): string {
  return value && /^\d+$/.test(value) ? value : fallback;
}

export function buildSessionName(
  profileName: string,
  env: NodeJS.ProcessEnv,
): string {
  const runId = numericOrFallback(env.GITHUB_RUN_ID, "0");
  const attempt = numericOrFallback(env.GITHUB_RUN_ATTEMPT, "1");
  const safeProfile = profileName.replace(/[^A-Za-z0-9_+=,.@-]/g, "-");
  const raw = `gha-${runId}-${attempt}-${safeProfile}`;
  return raw.slice(0, 64).padEnd(2, "0");
}

function safeContext(value: string | undefined, max = 1024): string {
  if (!value) return "";
  if (value.length > max || CONTROL_OR_NEWLINE.test(value)) {
    throw new Error("GitHub job context contains an unsafe value");
  }
  return value;
}

export function buildJobIdentity(env: NodeJS.ProcessEnv): JobIdentity {
  return {
    serverUrl: safeContext(env.GITHUB_SERVER_URL),
    repository: safeContext(env.GITHUB_REPOSITORY),
    workflow: safeContext(env.GITHUB_WORKFLOW),
    workflowRef: safeContext(env.GITHUB_WORKFLOW_REF),
    job: safeContext(env.GITHUB_JOB),
    runId: numericOrFallback(env.GITHUB_RUN_ID, "0"),
    runAttempt: numericOrFallback(env.GITHUB_RUN_ATTEMPT, "1"),
    ref: safeContext(env.GITHUB_REF),
  };
}
