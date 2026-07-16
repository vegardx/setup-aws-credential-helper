# Setup AWS credential helper

[![CI](https://github.com/vegardx/setup-aws-credential-helper/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/vegardx/setup-aws-credential-helper/actions/workflows/ci.yml)
[![Ubuntu 24 · amd64 + arm64](https://img.shields.io/github/actions/workflow/status/vegardx/setup-aws-credential-helper/offline-integration.yml?branch=main&label=Ubuntu%2024%20%C2%B7%20amd64%20%2B%20arm64)](https://github.com/vegardx/setup-aws-credential-helper/actions/workflows/offline-integration.yml)
[![Ubuntu 26 preview · amd64 + arm64](https://img.shields.io/github/actions/workflow/status/vegardx/setup-aws-credential-helper/ubuntu-26-compatibility.yml?branch=main&label=Ubuntu%2026%20preview%20%C2%B7%20amd64%20%2B%20arm64)](https://github.com/vegardx/setup-aws-credential-helper/actions/workflows/ubuntu-26-compatibility.yml)
[![Latest release](https://img.shields.io/github/v/release/vegardx/setup-aws-credential-helper?sort=semver)](https://github.com/vegardx/setup-aws-credential-helper/releases/latest)
[![License: MIT](https://img.shields.io/github/license/vegardx/setup-aws-credential-helper)](LICENSE)

**Renewable, multi-profile AWS credentials for long-running GitHub Actions jobs.**

This Linux action configures standard AWS [`credential_process`](https://docs.aws.amazon.com/sdkref/latest/guide/feature-process-credentials.html) profiles backed by GitHub Actions OIDC. Compatible AWS clients receive temporary STS credentials with an expiration and can invoke the helper again when they need replacements—without exporting AWS access keys into later steps.

## Why this exists

[`aws-actions/configure-aws-credentials`](https://github.com/aws-actions/configure-aws-credentials) is the established default for most jobs. In its normal OIDC mode it assumes a role during the action step and exports one temporary `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` / `AWS_SESSION_TOKEN` set. That is simple and appropriate when one session comfortably outlives the job's AWS work.

A fixed credential set becomes a liability when a deployment can outlive that session. Increasing the role duration only moves the boundary and requires broader credential lifetime. This action instead gives compatible consumers a renewable credential source:

```text
setup once
   │
   └─ generated AWS profiles (no exported access keys)
          │
          ├─ Terraform/OpenTofu S3 backend ── profile: state
          ├─ AWS provider / AWS CLI ───────── profile: deployment
          └─ other AWS SDK consumers ─────── profile: observability, dns, ...
                        │
                        └─ credential_process
                              ├─ return valid cached STS credentials, or
                              └─ request OIDC on demand → exchange with STS
```

### What you gain

- **Renewal across long operations.** Tested Terraform, OpenTofu, and AWS SDK clients reinvoke the helper across synthetic credential expiration instead of being permanently tied to the credential set created at setup time.
- **Shorter sessions without a brittle deadline.** You can request a shorter supported STS duration and let compatible consumers replace credentials as needed, rather than making every credential live for the maximum possible job duration.
- **Multiple least-privilege identities in one job.** Give state access, deployment, DNS, or other concerns separate roles and select them using ordinary AWS profile configuration.
- **Correct backend/provider separation.** Terraform/OpenTofu backends and providers are independent AWS consumers; each can use its own named profile and refresh lifecycle.
- **No exported AWS access-key variables.** Later steps receive profile/config selection, while credentials are produced only when a consumer invokes `credential_process`.
- **Shared refresh coordination.** Separate CLI, backend, provider, and SDK processes reuse a private job-local cache so concurrent demand normally produces one STS exchange per identity.

### Exported once vs renewable on demand

| | One-time exported credentials | This action |
| --- | --- | --- |
| Credential source seen by later tools | Fixed environment variables or static profile values | Standard named profile with `credential_process` |
| When STS credentials are obtained | During the setup action | On first demand and again when the selected client needs replacements |
| Long operation crosses initial expiry | The original values cannot replace themselves | Compatible clients can reinvoke the helper and continue with a new STS session |
| Multiple roles | Usually repeat setup and manage precedence carefully | One generated config with isolated named profiles |
| AWS access keys exported to later steps | Normally yes | No |
| Terraform S3 backend vs provider identity | Must be wired separately | Separate profiles are a first-class use case |

### The precise promise

Renewal is **request-driven**, not a background daemon. It requires a client that supports `credential_process`, honors `Expiration`, and continues using that provider. A later refresh also requires the job to remain active with usable `id-token: write` request capability and network access to GitHub and AWS STS. Static AWS credential environment variables or directly supplied credentials can take precedence and bypass process credentials; setup rejects common competing variables for that reason.

For the versions in this repository's compatibility suite, renewal is exercised by a long-lived AWS SDK v3 client and by one Terraform/OpenTofu `apply` process that makes provider and backend calls across a synthetic expiration boundary. This substantially reduces expiry risk; it does not guarantee that every in-flight request or every possible client survives every failure. See [Credential renewal and cache](#credential-renewal-and-cache), [What the tests prove](#what-the-tests-prove), and the [live-test checklist](docs/live-test-checklist.md).

## Quick start

Grant OIDC permission to only the job that needs AWS access. Run setup once near the start of every such job, before any AWS consumer:

```yaml
name: Deploy

on:
  workflow_dispatch:

jobs:
  deploy:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      id-token: write

    steps:
      - name: Configure renewable AWS profiles
        uses: vegardx/setup-aws-credential-helper@v1
        with:
          profiles: |
            [
              {
                "name": "state",
                "roleArn": "arn:aws:iam::111122223333:role/github-state",
                "region": "eu-west-1",
                "roleDurationSeconds": 900
              },
              {
                "name": "deployment",
                "roleArn": "arn:aws:iam::444455556666:role/github-deployment",
                "region": "us-east-1",
                "audience": "sts.amazonaws.com"
              }
            ]
          default-profile: deployment

      - name: Verify the default identity
        run: aws sts get-caller-identity
```

Replace the example account IDs, roles, and regions. The selected `default-profile` must name one of the supplied profiles; it is required even when only one profile is configured.

For released use, prefer an immutable full commit SHA. The floating `@v1` reference above is convenient for illustration but can move between compatible v1 releases. The release workflow creates immutable `vX.Y.Z` tags and moves `vX` only after the release succeeds.

### Inputs

`profiles` must be a non-empty JSON array containing at most 50 objects. Unknown fields are rejected. Each object supports:

| Field | Required | Contract |
| --- | --- | --- |
| `name` | yes | Unique, 1–64 characters, matching `[A-Za-z0-9][A-Za-z0-9_.-]*`; `default` is reserved |
| `roleArn` | yes | IAM role ARN in a supported AWS partition |
| `region` | yes | Regional STS region compatible with the ARN partition |
| `audience` | no | Defaults to `sts.amazonaws.com`; 1–255 characters, beginning with an alphanumeric character and otherwise using `A-Za-z0-9._:/-` |
| `roleDurationSeconds` | no | Defaults to `3600`; integer from `1` through `43200` |

The requested duration is not automatically reduced or clamped. Values below `900` are intended only for fast offline emulator tests: setup emits a warning because AWS STS documents a 900-second minimum and real AWS is expected to reject them. The role's IAM `MaxSessionDuration` remains authoritative, so STS also rejects a request that exceeds it.

`default-profile` is the profile exported as `AWS_PROFILE`.

### Generated environment

The action exports these values to **later steps in the same job**:

```text
AWS_CONFIG_FILE=<absolute path to a private generated AWS config>
AWS_PROFILE=<the default-profile input>
AWS_SDK_LOAD_CONFIG=1
```

It deliberately does not set `AWS_REGION` or `AWS_DEFAULT_REGION`. Each generated named profile has its own region, allowing profiles in different regions to coexist. A consumer that explicitly overrides its region still follows that consumer's normal precedence rules.

The generated config contains named `[profile <name>]` sections. Each section invokes the helper with the absolute Node executable captured by the action, the absolute bundled helper path in the action checkout, and private profile metadata. It does not depend on `node` being on `PATH`, shell expansion, or an executable file under `RUNNER_TEMP`.

## Consumer examples

All examples below run after the setup step and in the same job.

### AWS CLI

The selected default profile works without additional flags:

```yaml
- name: Use the deployment profile
  run: aws sts get-caller-identity
```

Select another generated profile with the standard CLI option:

```yaml
- name: Read state with the state profile
  run: aws --profile state s3api head-bucket --bucket "$STATE_BUCKET"
```

Do not copy the generated config to another job. Run the action again there.

### Terraform or OpenTofu: default provider

With no explicit `profile`, the AWS provider uses `AWS_PROFILE` (`deployment` in the quick start) and loads the generated shared config:

```hcl
terraform {
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
  }
}

provider "aws" {}

data "aws_caller_identity" "current" {}
```

Run either CLI later in the job:

```yaml
- run: terraform plan
# or
- run: tofu plan
```

Pin providers and modules to versions or checksums appropriate to your threat model; do not copy the illustrative provider constraint without reviewing it.

### Terraform or OpenTofu: provider aliases

Set `profile` on an aliased provider to select another generated profile. Regions can remain in the profiles, or be overridden explicitly by a provider when needed.

```hcl
provider "aws" {
  # Uses AWS_PROFILE, selected as "deployment" by the action.
}

provider "aws" {
  alias   = "state_reader"
  profile = "state"
}

data "aws_caller_identity" "deployment" {}

data "aws_caller_identity" "state" {
  provider = aws.state_reader
}
```

Provider aliases do not configure Terraform's or OpenTofu's state backend.

### Terraform or OpenTofu: S3 backend

The S3 backend and AWS providers are separate AWS SDK consumers. They authenticate independently and may invoke the credential helper independently. Configure the backend's `profile` and `shared_config_files` even when the provider uses the default profile.

Keep the source backend block free of runner-local paths:

```hcl
terraform {
  backend "s3" {
    bucket = "example-state-bucket"
    key    = "services/example.tfstate"
    region = "eu-west-1"
  }
}
```

After setup, create an untracked, job-local backend config from `AWS_CONFIG_FILE`, then initialize:

```yaml
- name: Initialize Terraform with the state profile
  shell: bash
  run: |
    cat > "$RUNNER_TEMP/backend.generated.hcl" <<EOF
    profile = "state"
    shared_config_files = ["$AWS_CONFIG_FILE"]
    EOF
    terraform init -backend-config="$RUNNER_TEMP/backend.generated.hcl"

- name: Plan with the deployment provider profile
  run: terraform plan -out="$RUNNER_TEMP/plan.tfplan"
```

For OpenTofu, use the same backend configuration with `tofu init` and `tofu plan`:

```yaml
- name: Initialize OpenTofu with the state profile
  shell: bash
  run: |
    cat > "$RUNNER_TEMP/backend.generated.hcl" <<EOF
    profile = "state"
    shared_config_files = ["$AWS_CONFIG_FILE"]
    EOF
    tofu init -backend-config="$RUNNER_TEMP/backend.generated.hcl"
```

Do not commit, cache, or upload `backend.generated.hcl`; its absolute path is valid only for this job. Although the generated shared config does not contain static access keys, it points to job-local private metadata and the action checkout.

### Planned Terraform/OpenTofu companion

This action intentionally remains a credential provider rather than a Terraform runner. A separate companion action is planned to compose with it: consume the generated profiles, create private backend configuration correctly, and run reviewed `plan`, `apply`, or `destroy` operations for Terraform or OpenTofu. Keeping execution separate lets this action remain useful to the AWS CLI, SDKs, and existing IaC workflows while the companion can own IaC-specific lifecycle and plan-safety decisions.

The intended boundary is:

- this action owns GitHub OIDC, STS exchange, renewable profiles, and shared credential caching;
- the companion owns engine invocation, working-directory/backend wiring, command arguments, and outputs;
- backend credentials select one generated profile, while provider and alias profile selection remains explicit in reviewed Terraform/OpenTofu configuration;
- plans, generated backend files, and local state remain sensitive job-local material unless a workflow deliberately protects and transfers them.

This is direction, not a released interface. See [Companion action design](docs/companion-action.md) for the initial product brief.

## Credential renewal and cache

Compatible AWS consumers execute `credential_process` when they need credentials and use the returned expiration according to their own caching behavior. On a refresh, the helper requests a fresh GitHub OIDC JWT and exchanges it with the profile's regional AWS STS endpoint. OIDC bearer tokens and JWTs are never written to the credential cache.

AWS CLI, Terraform/OpenTofu core and its S3 backend, provider plugins, and other SDK processes have separate in-process caches. To avoid redundant exchanges, helper invocations share temporary STS credentials in the generated private job directory:

- every effective profile and job identity has an isolated, hashed cache key;
- credentials refresh early: approximately 10% of the requested duration; sessions of at least 900 seconds use a 60-second to 5-minute bound, while shorter offline-test sessions use a proportional 1-second to 30-second bound;
- concurrent invocations for one identity coordinate through a bounded per-key lock and normally perform one OIDC/STS exchange;
- a waiter times out after about 30 seconds rather than bypassing a live lock and risking an unsafe duplicate refresh;
- cache records contain temporary STS credentials and their full canonical identity, but never OIDC JWTs or request bearer tokens.

Renewal depends on both the consumer honoring `Expiration` and GitHub's OIDC request capability still being available to the job. See [Limits](#limits) and [Troubleshooting](#troubleshooting).

## Security model

The GitHub Actions **job is the security boundary**. `id-token: write` makes the job's OIDC request capability available to workflow processes; it is not restricted to this action. Any code running as the job's Unix user can potentially request a GitHub OIDC token, invoke this helper, or read temporary credentials after issuance.

Only run trusted code in an OIDC-enabled job:

- do not check out and execute an unreviewed pull-request head with `id-token: write`;
- do not use `pull_request_target` to execute code from the pull request;
- pin and review actions, Terraform/OpenTofu providers, and modules;
- treat provider binaries, module code, `external` data sources, provisioners such as `local-exec`, build scripts, and downloaded tools as executable trusted code;
- isolate privileged deployment jobs from untrusted build/test jobs, passing only reviewed, integrity-protected inputs when separation is necessary.

Use IAM defense in depth:

- grant each role only the AWS permissions and resource scope it needs;
- scope the AWS IAM OIDC trust policy to the intended GitHub issuer, audience, repository, branch/tag/environment, and workflow context as appropriate;
- use GitHub environments and required reviewers for sensitive deployments;
- keep session durations no longer than operationally necessary.

JWT parsing by this action is only a diagnostic sanity check for shape, audience, issuer compatibility, and time claims. The helper does not fetch JWKS or locally authorize claims. AWS STS, the configured IAM OIDC provider, and the role trust policy are authoritative for token signature, issuer/provider, audience, subject, and authorization.

### Data at rest and cleanup

The generated root directory is mode `0700`; config, metadata, and cache records are mode `0600`. This reduces accidental exposure between users, but is **not** a security boundary against other code running as the same Unix user. Cache records hold usable temporary STS credentials until their expiration.

Post-job cleanup is best effort. It removes the generated directory when the runner executes the action's post step, but it cannot:

- revoke credentials already issued by STS;
- retract environment values already exported to job steps;
- erase credentials cached in a long-lived consumer process;
- guarantee deletion after runner failure, forced termination, or host compromise.

Prefer GitHub-hosted or otherwise ephemeral, single-job runners. If using self-hosted runners, isolate jobs and securely clean or replace the runner filesystem and process environment between jobs. Do not rely on this action as the runner's only cleanup control.

Terraform/OpenTofu plan files can contain sensitive values and enough configuration to drive privileged operations. Keep plans in private job-local storage when possible. If a plan must cross a trust boundary, protect its confidentiality and integrity, narrowly control artifact readers/writers, and review the limitations of applying saved plans on another runner. Never publish plans or generated helper directories as public artifacts.

See [SECURITY.md](SECURITY.md) to report a vulnerability privately.

## What the tests prove

The required, fork-safe CI uses controlled loopback OIDC/STS services and Moto. It uses no repository secrets, live AWS credentials, or `id-token: write`.

| Layer | What runs | What it establishes |
| --- | --- | --- |
| Unit and mocked subprocess tests | Vitest on cache, config, input, OIDC, STS, setup/helper/cleanup lifecycle, and the bundled helper process | Validation, process JSON shape, early-refresh boundaries, cache identity and permissions, single-flight locking, retry/failure behavior, and bundle isolation |
| Emulator smoke | AWS SDK JS v3, AWS CLI, and CloudFormation/SQS through Moto on Ubuntu 24.04 x64 and arm64 | Real signed requests through distinct `credential_process` profiles, S3 lifecycle, CloudFormation create/update/delete effects, negative controls, cache reuse, and container cleanup |
| Offline consumer acceptance | AWS SDK JS v3, AWS CLI, Terraform 1.15.8, OpenTofu 1.12.4, and AWS provider 6.54.0 on Ubuntu 24.04 x64 and arm64 | Default/explicit profiles; separate `state` backend and `deployment` provider resolution; S3 apply/read/update/destroy; cross-process cache single flight and profile isolation |
| SDK renewal probe | One long-lived AWS SDK v3 `S3Client` with a four-second synthetic STS session | The same client makes calls before and after the refresh boundary; credential-process, OIDC, and STS counters all advance; the renewed credential generation is then reused without an immediate refresh storm |
| Terraform/OpenTofu renewal probe | One `apply` process per engine with an eight-second synthetic STS session, a provider operation, a controlled ten-second pause, and a dependent provider operation | The same run completes provider work on both sides of expiration; its `deployment` provider and `state` backend credential-process/STS counters advance after the pre-expiration marker |
| Job-container lane | Node 24 job container plus a Moto service container | Inherited controlled OIDC variables, absolute helper/config paths, helper protocol output, SDK signing, and cleanup when setup and consumer share one job container |
| Ubuntu 26 canary | The same offline suite on x64 and arm64 public-preview runners | Early compatibility signal only; these jobs are intentionally not required |

The Terraform/OpenTofu renewal probe establishes request-driven provider refresh for the pinned engine/provider versions and the helper protocol. It does not prove that credentials are renewed in the background, that an in-flight request can replace credentials after it has been signed, or that every Terraform operation is immune to expiry-related failure. Renewal still depends on the selected consumer asking for credentials again and on the helper successfully reaching GitHub OIDC and AWS STS.

The offline suite also does not validate real GitHub OIDC service longevity, AWS JWT signature validation, IAM OIDC provider/trust conditions, role `MaxSessionDuration`, permissions boundaries, AWS rejection of actually expired credentials, or service availability/rate limits. Those checks remain in the deferred owner-run [live-test checklist](docs/live-test-checklist.md).

## Limits

Version 1 intentionally supports:

- Linux runners on Ubuntu 24.04 x64 and arm64;
- later steps in the same non-container job, plus a GitHub Actions Linux job container where setup and consumers share that job container;
- trusted workflow code;
- consumers that support AWS shared config, named profiles, and `credential_process` expiration.

Operational constraints:

- Run setup in every job that needs credentials. Generated configuration, metadata, cache paths, the captured Node executable, and the action checkout path are job-local and must not be transferred between jobs or runners.
- The tested job-container case keeps setup, inherited OIDC runtime variables, absolute Node/helper/metadata/cache paths, and the consumer in one `jobs.<job>.container`. Separately launched containers, service or sibling containers, Kubernetes pods, remote containers, and cross-job transfer are not supported or implied. Windows and macOS remain unsupported.
- The action checkout must remain present at its original absolute path, and the captured action Node runtime must remain runnable for later helper invocations. Do not delete or relocate the action directory.
- Different profiles can use different regions. The action intentionally does not export a global AWS region; explicitly set a consumer-level region only when you mean to override profile behavior.
- Setup fails when static credentials, standard web-identity variables, or container credential endpoint variables are already present. This avoids silently selecting a credential source that bypasses the generated process profile.
- Requested STS durations are 1–43200 seconds and are forwarded unchanged. AWS STS documents a 900-second minimum, so real AWS is expected to reject values below 900; those values exist for offline emulator tests. AWS IAM role `MaxSessionDuration` and other STS policy limits still apply.
- Cache coordination protects cooperating processes, not malicious same-user code. A lock timeout fails the helper instead of performing an uncoordinated exchange.
- OIDC requests and STS exchanges require network access at refresh time. GitHub's repeated full-job OIDC availability and service rate limits are runtime behavior, not a guarantee made by this action.
- Cleanup does not revoke credentials and may not run after forceful runner termination.

## Troubleshooting

The helper writes credential JSON only to stdout. Bounded, sanitized diagnostics go to stderr, with URL- and JWT-shaped values redacted. Do not enable shell tracing or add commands that print OIDC runtime variables, generated metadata, cache records, credential JSON, or Terraform plan contents.

### `GitHub OIDC runtime variables are missing`

The job normally lacks effective OIDC permission. Add job-level:

```yaml
permissions:
  contents: read
  id-token: write
```

Check that a reusable workflow's caller/callee permission intersection does not remove `id-token: write`, and that organization/repository policy permits OIDC. Run the consumer after the setup step and in the same job.

### STS returns `AccessDenied` or an invalid identity token

Check all of the following without printing the token:

1. `roleArn`, partition, region, and `audience` match the AWS IAM OIDC provider and role.
2. The role trust policy allows the actual repository, ref or environment, workflow context, subject, issuer, and audience.
3. The requested duration does not exceed the role's `MaxSessionDuration`.
4. The job is running in the expected GitHub repository/ref/environment, rather than an event with different OIDC claims.
5. Runner time and outbound HTTPS access are healthy.

AWS STS is authoritative. Do not weaken the trust policy merely to make a failed request pass.

### `timed out waiting for the credential cache refresh lock`

Another process using the same effective identity did not publish credentials within about 30 seconds. Look for a stalled AWS consumer, severe filesystem latency, or unavailable GitHub OIDC/STS services. Retry the consumer only after checking the earlier process. Do not manually delete locks while another helper may still be running; rerunning the entire job gives setup a fresh private cache.

### Renewal worked earlier but later fails

The cached STS credentials may have reached the early-refresh boundary while the job's GitHub OIDC request capability is no longer usable—for example, after cancellation or a runtime/service failure. The helper cannot renew without the runtime request URL/token and network access to GitHub and STS. Start a new job rather than copying old generated state. Also confirm that the AWS client honors `credential_process` expiration and can refresh credentials.

### Setup reports competing AWS credential variables

Remove the named variables reported by the action from the job, runner service, environment, or prior workflow step. Common conflicts include static `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN`, `AWS_WEB_IDENTITY_TOKEN_FILE`/`AWS_ROLE_ARN`, and container credential endpoint variables. The action intentionally fails instead of unsetting or overriding them.

### A profile uses the wrong region or identity

Use `aws --profile <name> ...` or provider `profile = "<name>"` to select a non-default profile. Configure an S3 backend separately with both `profile` and `shared_config_files`. Inspect ordinary caller identity output—not credentials—to confirm which role is active. Remove unintended `AWS_REGION`, `AWS_DEFAULT_REGION`, or explicit provider/backend region overrides.

## Development

Automated tests use mocked local OIDC and STS endpoints; they require no live AWS account, role, account ID, or `id-token: write` permission.

```bash
npm ci
npm run check
npm run test:coverage
```

The production JavaScript bundles in `dist/` are committed. See [CONTRIBUTING.md](CONTRIBUTING.md) for development and review expectations and [docs/architecture.md](docs/architecture.md) for component boundaries.

Live AWS/OIDC validation is intentionally not part of CI. The repository owner can follow the separate [deferred live-test checklist](docs/live-test-checklist.md) when a least-privilege test role is available. Releases publish only GitHub tags and release notes; the project is not published to npm or GitHub Marketplace.

## License

[MIT](LICENSE)
