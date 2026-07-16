import { describe, expect, it } from "vitest";

import { sanitizeDiagnostics } from "./emulator/adapter.js";

describe("emulator diagnostic sanitization", () => {
  it("redacts plain and JSON-quoted credential fields", () => {
    const diagnostics = [
      "Authorization: Bearer request-token",
      '"SecretAccessKey": "json-secret"',
      '"SessionToken":"json-session"',
      "WebIdentityToken=plain-jwt",
    ].join("\n");

    const sanitized = sanitizeDiagnostics(diagnostics);

    expect(sanitized).not.toContain("request-token");
    expect(sanitized).not.toContain("json-secret");
    expect(sanitized).not.toContain("json-session");
    expect(sanitized).not.toContain("plain-jwt");
    expect(sanitized.match(/\[redacted]/g)).toHaveLength(4);
  });
});
