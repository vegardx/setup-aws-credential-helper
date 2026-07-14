import {
  AssumeRoleWithWebIdentityCommand,
  STSClient,
  type AssumeRoleWithWebIdentityCommandOutput,
} from "@aws-sdk/client-sts";

import type { AwsCredentials, ProfileMetadata } from "./types.js";

export interface StsClientLike {
  send(
    command: AssumeRoleWithWebIdentityCommand,
  ): Promise<AssumeRoleWithWebIdentityCommandOutput>;
}

export function createStsClient(metadata: ProfileMetadata): StsClientLike {
  return new STSClient({
    region: metadata.region,
    endpoint: metadata.stsEndpoint,
    maxAttempts: 3,
  });
}

export async function exchangeWebIdentity(options: {
  metadata: ProfileMetadata;
  webIdentityToken: string;
  client?: StsClientLike;
}): Promise<AwsCredentials> {
  const client = options.client ?? createStsClient(options.metadata);
  const response = await client.send(
    new AssumeRoleWithWebIdentityCommand({
      RoleArn: options.metadata.roleArn,
      RoleSessionName: options.metadata.sessionName,
      WebIdentityToken: options.webIdentityToken,
      DurationSeconds: options.metadata.roleDurationSeconds,
    }),
  );
  const credentials = response.Credentials;
  if (
    !credentials?.AccessKeyId ||
    !credentials.SecretAccessKey ||
    !credentials.SessionToken ||
    !(credentials.Expiration instanceof Date) ||
    !Number.isFinite(credentials.Expiration.getTime())
  ) {
    throw new Error("AWS STS returned incomplete temporary credentials");
  }
  return {
    accessKeyId: credentials.AccessKeyId,
    secretAccessKey: credentials.SecretAccessKey,
    sessionToken: credentials.SessionToken,
    expiration: credentials.Expiration.toISOString(),
  };
}
