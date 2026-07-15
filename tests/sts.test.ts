import { AssumeRoleWithWebIdentityCommand } from "@aws-sdk/client-sts";
import { describe, expect, it, vi } from "vitest";

import { exchangeWebIdentity } from "../src/sts.js";
import type { ProfileMetadata } from "../src/types.js";

const metadata: ProfileMetadata = {
  version: 1,
  name: "prod",
  roleArn: "arn:aws:iam::123456789012:role/prod",
  region: "eu-west-1",
  audience: "sts.amazonaws.com",
  roleDurationSeconds: 900,
  partition: "aws",
  sessionName: "gha-1-1-prod",
  jobIdentity: {
    serverUrl: "https://github.com",
    repository: "owner/repo",
    workflow: "deploy",
    workflowRef: "",
    job: "deploy",
    runId: "1",
    runAttempt: "1",
    ref: "refs/heads/main",
  },
  stsEndpoint: "https://sts.eu-west-1.amazonaws.com",
  cacheRoot: "/tmp/cache",
};

describe("STS exchange", () => {
  it("sends exact effective role inputs and validates output", async () => {
    const send = vi.fn().mockResolvedValue({
      Credentials: {
        AccessKeyId: "ASIAEXAMPLE",
        SecretAccessKey: "secret",
        SessionToken: "session",
        Expiration: new Date("2026-01-01T00:15:00Z"),
      },
    });
    await expect(
      exchangeWebIdentity({
        metadata,
        webIdentityToken: "jwt-secret",
        client: { send },
      }),
    ).resolves.toEqual({
      accessKeyId: "ASIAEXAMPLE",
      secretAccessKey: "secret",
      sessionToken: "session",
      expiration: "2026-01-01T00:15:00.000Z",
    });
    const command = send.mock.calls[0]![0];
    expect(command).toBeInstanceOf(AssumeRoleWithWebIdentityCommand);
    expect(command.input).toEqual({
      RoleArn: metadata.roleArn,
      RoleSessionName: metadata.sessionName,
      WebIdentityToken: "jwt-secret",
      DurationSeconds: 900,
    });
  });

  it("fails incomplete responses", async () => {
    await expect(
      exchangeWebIdentity({
        metadata,
        webIdentityToken: "jwt-secret",
        client: { send: vi.fn().mockResolvedValue({ Credentials: {} }) },
      }),
    ).rejects.toThrow("incomplete");
  });
});
