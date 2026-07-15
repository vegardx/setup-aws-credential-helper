# Architecture

This project has three separately bundled JavaScript entrypoints and a generated, job-local data directory. The separation is intentional: setup uses GitHub Actions workflow commands, while the credential process must implement a strict external-process protocol.

## Lifecycle

```text
setup step (dist/setup.cjs)
  ├─ validates action inputs, platform, environment, and paths
  ├─ creates private metadata, AWS config, and cache roots in RUNNER_TEMP
  ├─ exports AWS_CONFIG_FILE, AWS_PROFILE, AWS_SDK_LOAD_CONFIG
  └─ saves only the generated directory path for post cleanup

later AWS consumer process
  └─ reads generated profile from AWS_CONFIG_FILE
       └─ credential_process launches captured Node + dist/helper.cjs
            ├─ reads private metadata for exactly one profile
            ├─ returns a valid cached STS session when available
            └─ otherwise requests GitHub OIDC → calls regional AWS STS

post step (dist/cleanup.cjs, always())
  └─ validates saved path and best-effort removes generated directory
```

## Setup boundary

`src/setup.ts` and `src/config.ts` are the action's main entrypoint. Setup may use `@actions/core` because it runs as a normal JavaScript action step. It:

- accepts and strictly validates the profile array and selected default;
- rejects unsupported platforms and competing AWS credential environment sources;
- verifies absolute action, runtime, and runner temporary paths;
- creates a private child of `RUNNER_TEMP` with fixed generated basenames;
- writes mode `0600` profile metadata and shared AWS config beneath a mode `0700` directory;
- puts one named profile section per input profile in that config;
- captures `process.execPath` and the bundled helper's absolute path in each `credential_process` command;
- exports only config/profile selection variables, not AWS credentials or a global region;
- saves only the generated directory path as post-action state.

A partial setup failure removes the new directory before failing. Generated state is meaningful only to later steps in that job; it is not a portable credential artifact.

## Credential-helper boundary

`src/helper.ts` is bundled independently as `dist/helper.cjs`. It is an AWS external-process protocol endpoint, not a GitHub Actions step. Its stdout must contain exactly one compact Version 1 process-credential JSON document and nothing else. Consequently, the production helper does not import `@actions/core`: workflow commands, debug text, or accidental stdout logging would corrupt the protocol response.

The helper accepts one absolute private metadata path selected by the generated profile. It validates the metadata again, builds a canonical cache identity from every effective credential-affecting input, and calls the cache layer. When a refresh is required it:

1. reads GitHub's OIDC request URL and bearer token from the current job environment;
2. requests a fresh JWT for the configured audience;
3. performs non-authoritative local checks of response/JWT shape, issuer compatibility, audience, and time claims;
4. sends the JWT, role ARN, duration, and normalized session name to the partition-compatible regional AWS STS endpoint;
5. requires complete expiring STS credentials before publishing them to the private cache.

Failures produce bounded, sanitized stderr diagnostics and a nonzero exit. OIDC bearer tokens and JWTs are neither logged nor cached.

## Why AWS STS is authoritative

JWT payloads are readable without verifying their signature. The helper's local decoding is useful for early diagnostics but cannot establish that GitHub signed a token or that a role should trust its claims. The action intentionally does not fetch OIDC discovery metadata or JWKS in v1 and does not make an authorization decision from locally decoded claims.

AWS STS evaluates `AssumeRoleWithWebIdentity` against the AWS account's configured IAM OIDC provider and role trust policy. AWS is therefore authoritative for:

- JWT signature and configured identity provider;
- issuer and audience acceptance;
- subject and other trust-policy conditions;
- whether the caller may assume the requested role;
- role session-duration and policy constraints.

This keeps authorization at the system that grants AWS credentials and avoids presenting lightweight local inspection as a security boundary.

## Shared cache boundary

`src/cache.ts` coordinates helper processes for AWS CLI, Terraform/OpenTofu core and backends, provider plugins, and other SDK consumers. Cache keys hash a deterministic canonical identity that includes profile, role, audience, duration, session/job context, partition, and the actual STS endpoint. The complete identity is also stored and compared on read.

Records are private regular files written through exclusive same-directory temporary files and atomic rename. A per-identity atomic directory lock provides cross-process single flight. Waiters re-read after locking; definitely dead owners can be recovered conservatively; a live-lock timeout fails closed instead of performing an uncoordinated refresh. Credentials are rejected near expiration or when identity, format, permissions, timestamps, or shape are invalid.

The cache is designed for cooperating processes. It does not protect credentials from malicious code running under the same Unix user. The generated root, including cache records, is removed only best effort.

## Cleanup boundary

`src/cleanup.ts` is the post entrypoint. It reads the saved generated-directory state, resolves and checks `RUNNER_TEMP`, and removes only an expected direct generated child beneath that root. Cleanup is idempotent and reports warnings rather than failing the job, so it cannot replace the primary job result.

Cleanup does not revoke STS sessions, retract previously exported environment variables, clear consumer process memory, or guarantee erasure when the runner is forcefully terminated.

## Build and test boundaries

The three production bundles are committed:

- `dist/setup.cjs`
- `dist/helper.cjs`
- `dist/cleanup.cjs`

Automated tests use injected dependencies and a separately generated ignored `dist-test/helper.cjs`. Only that test bundle permits local plaintext mock OIDC/STS endpoints. The production build compiles this capability out; it must not become runtime-configurable.

No live AWS account, role, OIDC permission, or credential belongs in automated tests or repository workflows. See [live-test-checklist.md](live-test-checklist.md) for the separate owner-run validation procedure.
