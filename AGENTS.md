# Project and contributor guide

This file is the canonical guide for contributors and coding agents working on `vegardx/setup-aws-credential-helper`. Keep changes within the project's narrow purpose: a GitHub Action that configures renewable, job-local AWS named profiles through the standard `credential_process` interface. Terraform wrappers, deployment workflows, live IAM infrastructure, and cross-job credential transport are out of scope.

## Architecture and support boundary

The action has three Node.js 24 entrypoints:

- `src/setup.ts` validates inputs, creates private job-local metadata and AWS config, exports profile selection, and saves only cleanup state.
- `src/helper.ts` is invoked later by AWS consumers. It acquires a fresh GitHub OIDC JWT, calls regional AWS STS, coordinates the shared temporary-credential cache, and writes only AWS process-credential JSON to stdout.
- `src/cleanup.ts` is the best-effort post action. It removes only the validated generated directory and must never mask the primary job result.

Version 1 supports Linux non-container jobs and GitHub Actions Linux job containers where setup and consumers share the same job container. Run setup in every job. Do not promise Windows, macOS, separately launched/service/sibling/Kubernetes/remote containers, or cross-job portability without a deliberate design and test change.

Important paths:

- `action.yml` — public inputs and setup/post entrypoints.
- `src/` — input, config, OIDC, STS, cache, helper, and cleanup implementation.
- `tests/` — unit, lifecycle, mocked subprocess, and fork-safe Moto real-consumer tests.
- `tests/integration/` — exact IaC pins, checksums, engine-specific provider locks, and HCL fixtures.
- `dist/` — committed production JavaScript bundles executed by GitHub Actions and AWS clients.
- `scripts/` — distribution, workflow, and release policy checks.
- `.github/workflows/` — CI, workflow-security, and release automation.
- `README.md`, `docs/architecture.md`, and `SECURITY.md` — user guidance, design boundaries, and vulnerability reporting.

## Security invariants

The GitHub Actions job is the security boundary. Every executable in a job with `id-token: write` can potentially inherit the OIDC request capability, invoke the helper, or read same-user temporary credentials. Treat actions, scripts, Terraform/OpenTofu providers and modules, external data sources, and provisioners as trusted code. Never execute an unreviewed pull-request head in a privileged job or use `pull_request_target` to run it.

GitHub OIDC bearer tokens and JWTs must not be logged or cached. Local JWT inspection is diagnostic only; AWS STS and IAM trust policy remain authoritative. Helper stdout must contain exactly one compact credential document, while bounded sanitized diagnostics go to stderr.

The cache is private, job-local, identity-bound, and shared by cooperating processes. Preserve strict modes, symlink defenses, atomic writes, per-key locking, conservative refresh, and fail-closed behavior. It does not defend against malicious code under the same Unix user. Cleanup is best effort and cannot revoke issued STS credentials or erase credentials already cached by consumers.

Normal CI uses controlled local OIDC/STS services and Moto only. The required `Offline integration` check is fork-safe, has `contents: read`, no secrets, and no `id-token: write`. It executes real SDK, CLI, Terraform, OpenTofu, provider-v6, S3, CloudFormation/SQS, cache, renewal, native x64/arm64, and same-job-container paths. Moto is API plumbing, not an AWS security oracle: real GitHub OIDC bearer longevity, AWS JWT verification, IAM OIDC/trust, role `MaxSessionDuration`, permissions boundaries, and real expiration rejection remain unproven and owner-run. Never add live AWS credentials, account-specific roles, IAM resources, LocalStack bootstrap/janitors, or `id-token: write` to repository CI.

## Development and verification

Use Node.js 24 or later and the committed npm lockfile. Start a fresh worktree with:

```bash
npm ci
```

Before opening a pull request, run:

```bash
npm run format:check
npm run lint
npm run typecheck
npm run test:coverage
npm run build
npm run verify:dist
npm run check:workflows
npm run check:release
```

Also run `npm run test:offline` on Linux with Docker, AWS CLI, Terraform 1.15.8, and OpenTofu 1.12.4 when changing integration fixtures. The required workflow installs IaC archives using `tests/integration/toolchain.json` checksums. Run actionlint and zizmor checks when workflow files change.

GitHub Actions executes `dist/setup.cjs` and `dist/cleanup.cjs`; AWS clients execute `dist/helper.cjs`. Source changes that affect an entrypoint must include rebuilt `dist/` files in the same pull request. Never hand-edit bundles. `npm run verify:dist` must prove that committed bundles reproduce from source and that the production helper excludes `@actions/core` and local HTTP test hooks.

## Branches, pull requests, and releases

Use short-lived branches and focused pull requests. The repository accepts rebase merges only, so keep a linear, understandable history and update the branch before merge. The always-running required checks are `Verify source, tests, and bundles` and the stable `Offline integration` aggregate. Ubuntu 26.04 x64/arm64 is public-preview canary coverage and must not be required while GitHub labels it preview.

Commit subjects must follow Conventional Commits because they are the release input. In particular:

- `fix:` produces a patch release.
- `feat:` produces a minor release.
- a `BREAKING CHANGE:` footer or breaking `type!:` produces a major release.
- non-release types such as `docs:`, `test:`, `ci:`, and `chore:` do not normally release.

Every push to `main` runs semantic-release after full verification. A releasable Conventional Commit causes semantic-release to create an immutable `vX.Y.Z` tag and a GitHub Release containing generated release notes. Only after that succeeds may automation move the floating `vX` action tag to the same commit.

GitHub Releases are the project's only changelog. Never create or update `CHANGELOG.md` (or another repository changelog), never add `@semantic-release/changelog` or `@semantic-release/git`, and never make release commits. The package is private and releases do not publish to npm or GitHub Marketplace.
