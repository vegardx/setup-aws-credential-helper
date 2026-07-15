export const PROFILE_METADATA_VERSION = 1 as const;
export const CACHE_FORMAT_VERSION = 1 as const;
export const CACHE_IDENTITY_SCHEMA = 1 as const;

export type AwsPartition =
  | "aws"
  | "aws-cn"
  | "aws-us-gov"
  | "aws-iso"
  | "aws-iso-b"
  | "aws-iso-e"
  | "aws-iso-f";

export interface Profile {
  name: string;
  roleArn: string;
  region: string;
  audience: string;
  roleDurationSeconds: number;
  partition: AwsPartition;
}

export interface JobIdentity {
  serverUrl: string;
  repository: string;
  workflow: string;
  workflowRef: string;
  job: string;
  runId: string;
  runAttempt: string;
  ref: string;
}

export interface ProfileMetadata extends Profile {
  version: typeof PROFILE_METADATA_VERSION;
  sessionName: string;
  jobIdentity: JobIdentity;
  stsEndpoint: string;
  cacheRoot: string;
}

export interface CacheIdentity {
  schema: typeof CACHE_IDENTITY_SCHEMA;
  profileName: string;
  roleArn: string;
  audience: string;
  durationSeconds: number;
  sessionName: string;
  jobIdentity: JobIdentity;
  partition: AwsPartition;
  stsEndpoint: string;
}

export interface AwsCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string;
  expiration: string;
}

export interface CacheRecord {
  formatVersion: typeof CACHE_FORMAT_VERSION;
  identity: CacheIdentity;
  credentials: AwsCredentials;
  issuedAt: string;
  expiration: string;
}

export interface ProcessCredentialDocument {
  Version: 1;
  AccessKeyId: string;
  SecretAccessKey: string;
  SessionToken: string;
  Expiration: string;
}
