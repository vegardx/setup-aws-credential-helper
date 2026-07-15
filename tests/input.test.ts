import { describe, expect, it } from "vitest";

import {
  assertSupportedRuntime,
  buildSessionName,
  findCredentialEnvironmentConflicts,
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
    [[{ ...valid, roleDurationSeconds: 899 }], "900"],
    [[{ ...valid, roleDurationSeconds: 43201 }], "900"],
  ])("rejects invalid profiles %#", (profiles, message) => {
    expect(() => parseProfiles(JSON.stringify(profiles))).toThrow(message);
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
