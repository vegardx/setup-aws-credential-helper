# Offline integration suite

The fork-safe required suite uses Moto's moving `motoserver/moto:latest` tag. Every run logs the architecture-specific image ID, resolved repository digest, and Moto version. The tag intentionally follows upstream stable emulator updates; failures are reviewed before promotion rather than hiding version drift.

Pinned consumers:

- Terraform CLI `1.15.8`
- OpenTofu CLI `1.12.4`
- HashiCorp AWS provider v6 `6.54.0` (no v5 lane)
- AWS SDK JS v3 versions locked by `package-lock.json`
- runner AWS CLI, whose version is emitted by the runner/tool output

`tests/integration/toolchain.json` holds exact CLI versions and published Linux amd64/arm64 archive checksums. `scripts/install-integration-tools.sh` downloads with bounded retries/timeouts and verifies those checksums. Terraform and OpenTofu use their own provider lock file because registry packages/checksums differ.

The suite creates private `0700` roots and `0600` metadata/config/counter files. Controlled OIDC and synthetic STS generation counters contain profile names and counts only, never JWTs or credentials. Consumers have metadata access disabled, no static/web-identity/container credential environment source, explicit loopback emulator endpoints, and path-style S3. Every spawned process, HTTP request, image pull, and test has a bounded timeout. `finally` cleanup removes local processes/files/containers; workflow `always()` cleanup is the final cancellation/failure backstop.

Coverage includes:

- default and explicit SDK/CLI profiles and signed S3 lifecycle requests;
- concurrent independent credential-process executions sharing one cache generation;
- profile/cache identity isolation and no immediate refresh storm;
- a long-lived SDK client naturally crossing a four-second synthetic expiration, with credential-process/OIDC/STS counters advancing;
- Terraform and OpenTofu S3 backend (`state`) independent from provider (`deployment`), apply/read/update/destroy, distinct cache identities, and a single `apply` per engine with provider operations before and after an eight-second synthetic credential expiration, plus post-boundary refresh counters for both the provider and backend;
- CloudFormation (`cloudformation`) create/describe/update/delete with SQS effects independently read using another profile;
- native Ubuntu 24.04 x64 and arm64;
- one `jobs.<job>.container` path with inherited controlled OIDC environment, absolute helper paths, process JSON, S3 signing, and cleanup;
- Ubuntu 26.04 x64/arm64 as non-required public-preview canaries.

This does not validate real GitHub OIDC bearer longevity, AWS JWT signatures, IAM OIDC providers/trust conditions, role `MaxSessionDuration`, permissions boundaries, or rejection of actually expired AWS credentials. Moto's STS behavior is a protocol fixture, not an authorization result. Those checks remain in `live-test-checklist.md`; live AWS/LocalStack bootstrap and janitor automation are not implemented scope.
