import { describe, expect, it } from "vitest";

import {
  assertSupportedRuntime,
  buildSessionName,
  findCredentialEnvironmentConflicts,
  isValidEffectiveProfile,
  isValidTestLoopbackStsEndpoint,
  parseProfiles,
  stsEndpointForRegion,
  validateDefaultProfile,
} from "../src/input.js";

const valid = {
  name: "deployment",
  roleArn: "arn:aws:iam::123456789012:role/github/deploy",
  region: "eu-west-1",
};

describe("profile input validation", () => {
  it("applies defaults and validates the selected profile", () => {
    const profiles = parseProfiles(JSON.stringify([valid]));
    expect(profiles).toEqual([
      {
        ...valid,
        audience: "sts.amazonaws.com",
        roleDurationSeconds: 3600,
        partition: "aws",
      },
    ]);
    expect(validateDefaultProfile("deployment", profiles)).toBe("deployment");
  });

  it.each([
    [[{ ...valid, extra: true }], "unknown key"],
    [[valid, valid], "duplicate"],
    [[{ ...valid, name: "bad\nname" }], "safe"],
    [[{ ...valid, name: "default" }], 'must not be "default"'],
    [[{ ...valid, roleArn: "not-an-arn" }], "IAM role ARN"],
    [
      [{ ...valid, roleArn: "arn:aws-cn:iam::123456789012:role/x" }],
      "incompatible",
    ],
    [[{ ...valid, region: "eu-west-1\ncredential_process=x" }], "safe"],
    [[{ ...valid, audience: "bad audience" }], "unsafe"],
    [[{ ...valid, roleDurationSeconds: 0 }], "1 through 43200"],
    [[{ ...valid, roleDurationSeconds: -1 }], "1 through 43200"],
    [[{ ...valid, roleDurationSeconds: 1.5 }], "1 through 43200"],
    [[{ ...valid, roleDurationSeconds: "900" }], "1 through 43200"],
    [[{ ...valid, roleDurationSeconds: 43201 }], "1 through 43200"],
  ])("rejects invalid profiles %#", (profiles, message) => {
    expect(() => parseProfiles(JSON.stringify(profiles))).toThrow(message);
  });

  it.each([1, 2, 30, 299, 300, 899, 900, 3600, 43_200])(
    "accepts role duration %i unchanged",
    (roleDurationSeconds) => {
      expect(
        parseProfiles(JSON.stringify([{ ...valid, roleDurationSeconds }]))[0]
          ?.roleDurationSeconds,
      ).toBe(roleDurationSeconds);
    },
  );

  it("allows only a structurally exact test loopback STS endpoint", () => {
    expect(isValidTestLoopbackStsEndpoint("http://127.0.0.1:4566/")).toBe(true);
    for (const endpoint of [
      "http://localhost:4566/",
      "http://127.1:4566/",
      "http://2130706433:4566/",
      "http://[::1]:4566/",
      "https://127.0.0.1:4566/",
      "http://user@127.0.0.1:4566/",
      "http://127.0.0.1/",
      "http://127.0.0.1:0/",
      "http://127.0.0.1:65536/",
      "http://127.0.0.1:4566/path",
      "http://127.0.0.1:4566/?query=1",
      "http://127.0.0.1:4566/#fragment",
      "not a URL",
    ]) {
      expect(isValidTestLoopbackStsEndpoint(endpoint), endpoint).toBe(false);
    }
  });

  it("keeps non-endpoint effective metadata validation strict", () => {
    const effective = {
      name: "deployment",
      roleArn: valid.roleArn,
      region: valid.region,
      audience: "sts.amazonaws.com",
      roleDurationSeconds: 1,
      partition: "aws",
      sessionName: "gha-1-1-deployment",
      stsEndpoint: "http://127.0.0.1:4566/",
    };
    expect(
      isValidEffectiveProfile(effective, {
        allowTestLoopbackStsEndpoint: true,
      }),
    ).toBe(true);
    expect(isValidEffectiveProfile(effective)).toBe(false);
    for (const invalid of [
      { ...effective, roleArn: "invalid" },
      { ...effective, region: "bad" },
      { ...effective, audience: "bad audience" },
      { ...effective, roleDurationSeconds: 0 },
      { ...effective, partition: "aws-cn" },
      { ...effective, sessionName: "x" },
    ]) {
      expect(
        isValidEffectiveProfile(invalid, {
          allowTestLoopbackStsEndpoint: true,
        }),
      ).toBe(false);
    }
  });

  it("rejects malformed JSON, missing arrays, and missing defaults", () => {
    expect(() => parseProfiles("{")).toThrow("valid JSON");
    expect(() => parseProfiles("{}")).toThrow("non-empty JSON array");
    expect(() =>
      validateDefaultProfile("other", parseProfiles(JSON.stringify([valid]))),
    ).toThrow("must name one");
  });

  it("maps partition endpoints", () => {
    expect(stsEndpointForRegion("aws", "us-east-1")).toBe(
      "https://sts.us-east-1.amazonaws.com",
    );
    expect(stsEndpointForRegion("aws-cn", "cn-north-1")).toBe(
      "https://sts.cn-north-1.amazonaws.com.cn",
    );
    expect(stsEndpointForRegion("aws-iso", "us-iso-east-1")).toBe(
      "https://sts.us-iso-east-1.c2s.ic.gov",
    );
    expect(stsEndpointForRegion("aws-iso-b", "us-isob-east-1")).toBe(
      "https://sts.us-isob-east-1.sc2s.sgov.gov",
    );
    expect(stsEndpointForRegion("aws-iso-e", "eu-isoe-west-1")).toBe(
      "https://sts.eu-isoe-west-1.cloud.adc-e.uk",
    );
    expect(stsEndpointForRegion("aws-iso-f", "us-isof-south-1")).toBe(
      "https://sts.us-isof-south-1.csp.hci.ic.gov",
    );
    expect(
      parseProfiles(
        JSON.stringify([
          {
            name: "iso-b",
            roleArn: "arn:aws-iso-b:iam::123456789012:role/test",
            region: "us-isob-east-1",
          },
        ]),
      )[0]?.partition,
    ).toBe("aws-iso-b");
  });

  it("normalizes bounded role session names", () => {
    const sessionName = buildSessionName(
      "very-long-profile-name-that-will-be-bounded-to-aws-limits",
      {
        GITHUB_RUN_ID: "123456",
        GITHUB_RUN_ATTEMPT: "7",
      },
    );
    expect(sessionName).toMatch(/^gha-123456-7-[A-Za-z0-9_.@=-]+$/);
    expect(sessionName).toHaveLength(64);
  });

  it("rejects unsupported operating systems and conflicting credentials", () => {
    expect(() => assertSupportedRuntime("darwin")).toThrow("Linux");
    expect(
      findCredentialEnvironmentConflicts({ AWS_ACCESS_KEY_ID: "x" }),
    ).toEqual(["AWS_ACCESS_KEY_ID"]);
  });
});
