# Setup AWS credential helper

A Linux GitHub Action that configures renewable AWS credentials through the standard AWS `credential_process` interface. It creates private, job-local named profiles and renews AWS STS credentials from fresh GitHub Actions OIDC tokens when AWS clients invoke the helper.

## Usage

The workflow job must grant OIDC token permission. Re-run setup in every job that needs credentials.

```yaml
permissions:
  contents: read
  id-token: write

steps:
  - uses: vegardx/setup-aws-credential-helper@v1
    with:
      profiles: |
        [
          {
            "name": "backend",
            "roleArn": "arn:aws:iam::123456789012:role/github-backend",
            "region": "eu-west-1",
            "roleDurationSeconds": 900
          },
          {
            "name": "deployment",
            "roleArn": "arn:aws:iam::123456789012:role/github-deployment",
            "region": "us-east-1",
            "audience": "sts.amazonaws.com"
          }
        ]
      default-profile: deployment

  - run: aws sts get-caller-identity
```

`profiles` is a JSON array. Every object requires:

- `name`: unique safe AWS profile name
- `roleArn`: IAM role ARN
- `region`: region compatible with the ARN partition

Optional fields:

- `audience`: defaults to `sts.amazonaws.com`
- `roleDurationSeconds`: defaults to `3600`, valid range `900`–`43200`; the IAM role's `MaxSessionDuration` remains authoritative

The action exports `AWS_CONFIG_FILE`, `AWS_PROFILE`, and `AWS_SDK_LOAD_CONFIG=1` for later steps. It does not export a global region, because every profile carries its own region. Terraform backend and provider authentication are separate: select/configure the backend profile independently when it differs from the provider profile.

## Security and lifecycle

- Only Linux, trusted workflow code, same-job, non-container use is supported in v1.
- Static AWS credential and web-identity environment variables cause setup to fail rather than bypassing the generated profile.
- The private job directory uses mode `0700`; config, profile metadata, and cache records use `0600`.
- OIDC request bearer tokens and JWTs are never cached. The cache stores only identity-bound temporary STS credentials.
- JWT decoding is a diagnostic sanity check only. AWS STS, the configured OIDC provider, and the IAM trust policy perform authoritative signature and authorization validation.
- Every executable in a job with `id-token: write` can potentially obtain a token. Treat actions, scripts, Terraform providers/modules, `external`, and `local-exec` as trusted. Do not execute an untrusted PR head with privileged OIDC access or use `pull_request_target` for that purpose.
- Post cleanup is best effort. It cannot revoke already-issued STS credentials, undo environment exports, or guarantee deletion after forceful runner termination.
- Generated paths and the captured action Node runtime are valid only in the same job. Do not transfer the config or cache between jobs; run the action again.

## Local verification

No live AWS account is required by the automated suite. Unit and Linux subprocess tests use local mocked OIDC and STS endpoints.

```bash
npm ci
npm run check
npm run test:coverage
```

A future live integration should verify AWS CLI, Terraform/OpenTofu provider and S3 backend profile selection, 900-second renewal, repeated long-job OIDC requests, concurrent consumers, cancellation, and cleanup.
