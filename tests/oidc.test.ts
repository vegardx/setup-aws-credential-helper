import { Buffer } from "node:buffer";
import { describe, expect, it, vi } from "vitest";

import { acquireOidcToken, sanityCheckOidcToken } from "../src/oidc.js";

function jwt(claims: Record<string, unknown>): string {
  return [
    Buffer.from("{}").toString("base64url"),
    Buffer.from(JSON.stringify(claims)).toString("base64url"),
    "signature",
  ].join(".");
}

const now = Date.UTC(2026, 0, 1);
const githubClaims = {
  aud: "sts.amazonaws.com",
  iss: "https://token.actions.githubusercontent.com",
  iat: now / 1000 - 5,
  nbf: now / 1000 - 5,
  exp: now / 1000 + 300,
};

describe("GitHub OIDC", () => {
  it("accepts GitHub.com and GHE.com claim shapes", () => {
    expect(
      sanityCheckOidcToken({
        token: jwt(githubClaims),
        audience: "sts.amazonaws.com",
        requestUrl: new URL(
          "https://pipelines.actions.githubusercontent.com/token?x=1",
        ),
        nowMs: now,
      }),
    ).toMatchObject(githubClaims);
    expect(() =>
      sanityCheckOidcToken({
        token: jwt({
          ...githubClaims,
          iss: "https://token.actions.dnb.ghe.com",
        }),
        audience: "sts.amazonaws.com",
        requestUrl: new URL("https://pipelines.actions.dnb.ghe.com/dnb?x=1"),
        nowMs: now,
      }),
    ).not.toThrow();
  });

  it.each([
    [{ ...githubClaims, aud: "wrong" }, "audience"],
    [{ ...githubClaims, iss: "https://evil.example" }, "issuer"],
    [{ ...githubClaims, exp: now / 1000 - 100 }, "expiration"],
    [{ ...githubClaims, nbf: now / 1000 + 100 }, "not yet valid"],
    [{ ...githubClaims, iat: now / 1000 + 100 }, "issued-at"],
  ])("rejects invalid claims %#", (claims, message) => {
    expect(() =>
      sanityCheckOidcToken({
        token: jwt(claims),
        audience: "sts.amazonaws.com",
        requestUrl: new URL("https://token.actions.githubusercontent.com/?x=1"),
        nowMs: now,
      }),
    ).toThrow(message);
  });

  it("preserves query parameters, encodes audience, and sends bearer auth", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ value: jwt(githubClaims) }), {
        status: 200,
      }),
    );
    const result = await acquireOidcToken(
      "sts.amazonaws.com",
      {
        ACTIONS_ID_TOKEN_REQUEST_URL:
          "https://pipelines.actions.githubusercontent.com/token?api-version=2",
        ACTIONS_ID_TOKEN_REQUEST_TOKEN: "request-secret",
      },
      {
        fetch: fetchMock,
        now: () => now,
        sleep: vi.fn(),
        random: () => 0,
      },
    );
    expect(result).toBe(jwt(githubClaims));
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toContain("api-version=2");
    expect(String(url)).toContain("audience=sts.amazonaws.com");
    expect((init?.headers as Record<string, string>).authorization).toBe(
      "Bearer request-secret",
    );
  });

  it("retries transient status without exposing response bodies", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("secret response", { status: 500 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ value: jwt(githubClaims) }), {
          status: 200,
        }),
      );
    await expect(
      acquireOidcToken(
        "sts.amazonaws.com",
        {
          ACTIONS_ID_TOKEN_REQUEST_URL:
            "https://pipelines.actions.githubusercontent.com/token?x=1",
          ACTIONS_ID_TOKEN_REQUEST_TOKEN: "bearer-secret",
        },
        { fetch: fetchMock, now: () => now, sleep: vi.fn(), random: () => 0 },
      ),
    ).resolves.toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("requires runtime variables and HTTPS", async () => {
    await expect(acquireOidcToken("sts.amazonaws.com", {})).rejects.toThrow(
      "runtime variables",
    );
    await expect(
      acquireOidcToken("sts.amazonaws.com", {
        ACTIONS_ID_TOKEN_REQUEST_URL: "http://example.com/token?x=1",
        ACTIONS_ID_TOKEN_REQUEST_TOKEN: "x",
      }),
    ).rejects.toThrow("HTTPS");
  });
});
