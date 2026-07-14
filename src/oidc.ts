import { Buffer } from "node:buffer";

interface OidcClaims {
  aud?: unknown;
  exp?: unknown;
  iat?: unknown;
  iss?: unknown;
  nbf?: unknown;
}

export interface OidcDependencies {
  fetch: typeof fetch;
  now: () => number;
  sleep: (milliseconds: number) => Promise<void>;
  random: () => number;
}

function defaultOidcDependencies(): OidcDependencies {
  return {
    fetch: globalThis.fetch,
    now: Date.now,
    sleep: (milliseconds) =>
      new Promise((resolve) => setTimeout(resolve, milliseconds)),
    random: Math.random,
  };
}

function decodeClaims(token: string): OidcClaims {
  const segments = token.split(".");
  if (segments.length !== 3 || !segments[1]) {
    throw new Error("GitHub OIDC endpoint returned a malformed JWT");
  }
  try {
    const value = JSON.parse(
      Buffer.from(segments[1], "base64url").toString("utf8"),
    ) as unknown;
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new Error("not an object");
    }
    return value;
  } catch {
    throw new Error("GitHub OIDC JWT contains a malformed payload");
  }
}

function expectedIssuer(requestUrl: URL): string {
  const host = requestUrl.hostname.toLowerCase();
  if (
    process.env.CREDENTIAL_HELPER_TEST_ALLOW_HTTP === "1" &&
    requestUrl.protocol === "http:" &&
    (host === "127.0.0.1" || host === "localhost")
  ) {
    return requestUrl.origin;
  }
  if (
    host === "pipelines.actions.githubusercontent.com" ||
    host === "token.actions.githubusercontent.com"
  ) {
    return "https://token.actions.githubusercontent.com";
  }
  const match = /^(?:pipelines|token)\.actions\.([a-z0-9-]+)\.ghe\.com$/.exec(
    host,
  );
  if (match?.[1]) {
    return `https://token.actions.${match[1]}.ghe.com`;
  }
  throw new Error("GitHub OIDC request URL has an unsupported host");
}

function includesAudience(claim: unknown, audience: string): boolean {
  if (typeof claim === "string") return claim === audience;
  return (
    Array.isArray(claim) &&
    claim.every((item) => typeof item === "string") &&
    claim.includes(audience)
  );
}

export function sanityCheckOidcToken(options: {
  token: string;
  audience: string;
  requestUrl: URL;
  nowMs?: number;
}): OidcClaims {
  const claims = decodeClaims(options.token);
  if (!includesAudience(claims.aud, options.audience)) {
    throw new Error(
      "GitHub OIDC JWT audience does not match the requested audience",
    );
  }
  if (claims.iss !== expectedIssuer(options.requestUrl)) {
    throw new Error(
      "GitHub OIDC JWT issuer is incompatible with the runtime host",
    );
  }

  const nowSeconds = Math.floor((options.nowMs ?? Date.now()) / 1000);
  const skew = 60;
  if (
    typeof claims.exp !== "number" ||
    !Number.isFinite(claims.exp) ||
    claims.exp <= nowSeconds - skew ||
    claims.exp > nowSeconds + 3600
  ) {
    throw new Error("GitHub OIDC JWT expiration is invalid");
  }
  if (
    typeof claims.iat !== "number" ||
    !Number.isFinite(claims.iat) ||
    claims.iat > nowSeconds + skew ||
    claims.iat < nowSeconds - 3600
  ) {
    throw new Error("GitHub OIDC JWT issued-at time is invalid");
  }
  if (
    claims.nbf !== undefined &&
    (typeof claims.nbf !== "number" || claims.nbf > nowSeconds + skew)
  ) {
    throw new Error("GitHub OIDC JWT is not yet valid");
  }
  return claims;
}

function requestUrl(raw: string, audience: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("ACTIONS_ID_TOKEN_REQUEST_URL is malformed");
  }
  if (url.protocol !== "https:") {
    const localTestAllowed =
      process.env.CREDENTIAL_HELPER_TEST_ALLOW_HTTP === "1" &&
      (url.hostname === "127.0.0.1" || url.hostname === "localhost");
    if (!localTestAllowed) {
      throw new Error("GitHub OIDC request URL must use HTTPS");
    }
  }
  url.searchParams.set("audience", audience);
  return url;
}

function retryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

export async function acquireOidcToken(
  audience: string,
  env: NodeJS.ProcessEnv,
  injectedDependencies?: OidcDependencies,
): Promise<string> {
  const dependencies = injectedDependencies ?? defaultOidcDependencies();
  const rawUrl = env.ACTIONS_ID_TOKEN_REQUEST_URL;
  const requestToken = env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  if (!rawUrl || !requestToken) {
    throw new Error(
      "GitHub OIDC runtime variables are missing; grant id-token: write permission",
    );
  }
  const url = requestUrl(rawUrl, audience);
  const expected = expectedIssuer(url);
  let lastError = "request failed";

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    try {
      const response = await dependencies.fetch(url, {
        method: "GET",
        headers: {
          accept: "application/json",
          authorization: `Bearer ${requestToken}`,
        },
        redirect: "error",
        signal: controller.signal,
      });
      if (!response.ok) {
        lastError = `GitHub OIDC endpoint returned HTTP ${response.status}`;
        if (!retryableStatus(response.status)) throw new Error(lastError);
      } else {
        const body = (await response.json()) as unknown;
        if (
          typeof body !== "object" ||
          body === null ||
          Array.isArray(body) ||
          typeof (body as { value?: unknown }).value !== "string" ||
          (body as { value: string }).value.length === 0
        ) {
          throw new Error("GitHub OIDC endpoint returned an invalid response");
        }
        const token = (body as { value: string }).value;
        sanityCheckOidcToken({
          token,
          audience,
          requestUrl: url,
          nowMs: dependencies.now(),
        });
        return token;
      }
    } catch (error) {
      if (error instanceof Error) lastError = error.message;
      if (attempt === 2 || /HTTP 4\d\d/.test(lastError)) throw error;
    } finally {
      clearTimeout(timeout);
    }
    await dependencies.sleep(
      Math.floor(100 * 2 ** attempt + dependencies.random() * 100),
    );
  }
  throw new Error(`${expected} token request failed: ${lastError}`);
}
