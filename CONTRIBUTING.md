# Contributing

Thank you for helping improve `setup-aws-credential-helper`. Changes should preserve the project's narrow scope: configuring a renewable, job-local AWS `credential_process` from GitHub Actions OIDC. Terraform deployment wrappers, reusable deployment workflows, live AWS infrastructure, and cross-job credential transport are out of scope.

## Before opening a change

- For a security vulnerability, do **not** open a public issue. Follow [SECURITY.md](SECURITY.md).
- Open or reference an issue for substantial behavior or interface changes before investing in an implementation.
- Keep pull requests focused and explain security, compatibility, and user-visible consequences.
- Never commit credentials, account-specific role ARNs, OIDC tokens, generated configs/caches, sensitive plans, or live test output.

## Development

The project requires Node.js 24 or later and uses the committed `package-lock.json`:

```bash
npm ci
npm run check
npm run test:coverage
```

`npm run check` type-checks, lints, checks formatting, runs tests, and rebuilds all production bundles. JavaScript actions execute the committed files in `dist/`, not TypeScript directly. Include the relevant rebuilt bundles in a source change and confirm they contain only expected production behavior.

The automated suite must remain local and mocked. Do not add a workflow that requests a real GitHub OIDC token, uses live AWS credentials, embeds account IDs, or creates IAM resources. The owner-run live procedure is intentionally separate in [docs/live-test-checklist.md](docs/live-test-checklist.md).

When changing security-sensitive behavior, add tests for success and failure paths. Important invariants include:

- helper stdout contains only one valid AWS process-credential JSON document;
- bearer tokens, JWTs, AWS credentials, and noisy response bodies never enter logs;
- generated files remain private and job-local;
- cache identities include every credential-affecting input;
- cleanup remains path-constrained, idempotent, and unable to mask the job result;
- production `dist/helper.cjs` does not include `@actions/core` or local plaintext test endpoints.

## Pull requests

A pull request should:

1. describe the problem and why the chosen approach is appropriate;
2. call out action input/output, IAM, OIDC, cache, lifecycle, and platform effects;
3. update README or architecture documentation for changed behavior;
4. include or update tests;
5. include rebuilt `dist/` files when source changes affect an entrypoint;
6. pass the repository's required checks.

Use clear commit messages; Conventional Commit style is preferred. Maintainers may ask for commits to be reorganized before merge so releases and generated bundle reviews remain understandable.

## Contribution expectations

Participation must be respectful, constructive, and professional. Assume good intent, critique ideas rather than people, respect privacy, and avoid harassment or discriminatory conduct. Maintainers may edit or remove abusive content and restrict participation to protect the community. Report sensitive conduct concerns privately through the same contact path in [SECURITY.md](SECURITY.md).

By contributing, you agree that your contribution is licensed under the repository's [MIT License](LICENSE).
