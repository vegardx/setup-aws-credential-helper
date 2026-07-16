# Deferred owner-run live-test checklist

This checklist is intentionally **manual and deferred**. Offline CI now establishes process execution, profile selection, a long-lived SDK client crossing synthetic expiration, one Terraform/OpenTofu apply per engine with provider calls before and after synthetic expiration, S3 backend/provider separation, S3 and CloudFormation/SQS API plumbing, Ubuntu 24.04 x64/arm64, and a same-job Linux container. This checklist covers only what that suite cannot establish: real GitHub OIDC bearer longevity and JWT issuance, AWS signature/provider/trust evaluation, IAM permissions and boundaries, role `MaxSessionDuration`, real expired-credential rejection, and compatibility with live AWS. Do not turn it into a repository CI workflow in this milestone.

Use a private, temporary test workflow or branch under the repository owner's control. Do not commit real account IDs, role ARNs, bucket names, credentials, tokens, generated configuration, or test plans to this repository. Remove temporary cloud and workflow resources after testing.

## 1. Prepare an isolated test environment

- [ ] Use an ephemeral GitHub-hosted runner, or a dedicated ephemeral self-hosted runner that will be destroyed after the test.
- [ ] Create or select a personal test AWS account with no production access.
- [ ] Configure GitHub as an IAM OIDC provider with the intended audience (normally `sts.amazonaws.com`).
- [ ] Create separate least-privilege roles for:
  - [ ] a provider/CLI test identity with read-only access to harmless test resources;
  - [ ] an S3 backend test identity limited to one disposable state bucket and key prefix.
- [ ] Scope each role's trust policy to the exact GitHub issuer and audience, this repository, and the intended branch, environment, and/or workflow identity. Do not use a wildcard that permits unrelated repositories or refs.
- [ ] Set role session and permission policies no broader than necessary. Confirm the role accepts a requested 900-second web-identity session.
- [ ] Create disposable resources needed for the checks, such as an empty state bucket and a harmless object or caller-identity target. Enable bucket versioning and encryption if state will be written.
- [ ] Add a protected GitHub environment with required review if the test roles can mutate any AWS resource.
- [ ] Review every action, script, provider, module, and downloaded executable used by the privileged job. Pin third-party actions to full commit SHAs and providers/modules according to their lock mechanisms.

Record only non-secret evidence: workflow run URL, commit SHA, tool versions, timestamps, expected role names, caller identity account/ARN after redaction where needed, and relevant CloudTrail event IDs. Never record OIDC runtime variables or credential values.

## 2. Create a temporary manual workflow

Create a workflow outside this milestone's committed files, triggerable only with `workflow_dispatch`. Give the test job exactly:

```yaml
permissions:
  contents: read
  id-token: write
```

Configure two profiles through the action:

- a provider/CLI profile selected by `default-profile`;
- a backend profile for the disposable S3 state location;
- `roleDurationSeconds: 900` on both profiles.

Use placeholders or encrypted configuration for the real role ARNs. Do not echo the action inputs if that would reveal identifiers you consider sensitive. Do not enable shell tracing (`set -x`) or AWS SDK wire/debug logging.

At the start of the job, capture tool versions and verify that the action exports non-empty `AWS_CONFIG_FILE`, the intended `AWS_PROFILE`, and `AWS_SDK_LOAD_CONFIG=1` without printing file contents. Verify `AWS_REGION` and `AWS_DEFAULT_REGION` were not introduced by the action.

## 3. Validate AWS CLI and profile selection

- [ ] Run `aws sts get-caller-identity` with no profile option and confirm the default role.
- [ ] Run `aws --profile <backend-profile> sts get-caller-identity` and confirm the distinct backend role.
- [ ] Confirm ordinary regional commands for both profiles use their configured profile regions.
- [ ] Confirm no static AWS access key, session token, or standard web-identity file variables were added to the environment.
- [ ] On a disposable run, deliberately pre-set one competing credential variable and confirm setup fails clearly rather than selecting the wrong source. Do not use a real credential value.

## 4. Validate a current AWS SDK

Use a small, reviewed script with a current supported AWS SDK and default credential/config resolution. Do not pass credentials into the script.

- [ ] With the default profile, call STS `GetCallerIdentity` and confirm the provider/CLI role.
- [ ] Select the second named profile through that SDK's standard shared-config mechanism and confirm the backend role.
- [ ] Keep one SDK process alive across at least one 900-second STS expiration boundary, make periodic harmless calls, and confirm the SDK refreshes rather than retaining expired credentials.
- [ ] Run a fresh SDK process after the boundary to confirm cross-process cache/renewal behavior.

If an SDK does not support `credential_process` or does not refresh expiring process credentials, document that consumer limitation rather than weakening the helper protocol.

## 5. Validate Terraform and OpenTofu providers

Use a reviewed, locked configuration containing only a caller-identity data source or similarly harmless resource. Perform the Terraform and OpenTofu checks separately with current supported versions.

- [ ] Initialize with locked provider selections.
- [ ] Run `plan` with the default AWS provider and confirm it uses the provider/CLI role.
- [ ] Add an aliased AWS provider with `profile = "<backend-profile>"`; query caller identity through both provider instances and confirm each role.
- [ ] Keep a provider operation or repeated read-only operations running across a 900-second boundary and confirm calls continue with renewed credentials.
- [ ] Repeat the default-provider and alias checks with OpenTofu.
- [ ] Keep plans in job-local private storage and delete them after inspection. Do not upload plans as artifacts for this test.

## 6. Validate the S3 backend independently

The backend must not rely on provider configuration.

- [ ] Create a job-local backend config containing the backend profile and `shared_config_files = ["<value of AWS_CONFIG_FILE>"]` as shown in the README.
- [ ] Run `terraform init` against the disposable bucket/key and confirm CloudTrail attributes backend access to the backend role.
- [ ] Run a harmless state operation and a provider caller-identity read; confirm backend access uses the backend role while provider access uses the default provider role.
- [ ] Repeat with `tofu init` and a separate disposable key.
- [ ] Verify the job-local backend config and state/plan files are not committed, cached, or uploaded.

## 7. Validate renewal for more than one hour

This is the key deferred runtime check. Success demonstrates that later helper invocations can still use the job's OIDC request capability; do not print or decode the JWTs.

- [ ] Keep one workflow job alive for **more than 60 minutes**.
- [ ] Use 900-second requested STS sessions throughout.
- [ ] Every few minutes, start a fresh AWS CLI process for each profile and make a harmless API call.
- [ ] Include calls near and after several expiration boundaries, including at least one successful renewal after the job has been running for more than one hour.
- [ ] Keep a current SDK process alive and perform periodic calls in the same interval.
- [ ] Repeat periodic Terraform/OpenTofu provider or backend read-only operations if their execution model permits it.
- [ ] Confirm calls continue succeeding and CloudTrail shows multiple `AssumeRoleWithWebIdentity` events at expected refresh intervals for the intended roles.
- [ ] Confirm no token, bearer header, access key, secret key, session token, generated config content, or cache record appears in logs.

Do not claim a general GitHub availability or rate-limit guarantee from one successful run. Record the GitHub-hosted runner image and date because this is observed runtime behavior.

## 8. Validate concurrent consumers

After allowing cached credentials to enter their early-refresh window, trigger several reviewed consumers at nearly the same time:

- [ ] multiple fresh AWS CLI processes for one profile;
- [ ] an SDK process;
- [ ] Terraform/OpenTofu backend or provider reads where practical;
- [ ] simultaneous calls for the second profile.

Confirm all calls receive the correct identities and no helper output is malformed. Use CloudTrail timestamps to check that same-profile calls normally coalesce into one STS refresh while different profiles remain independent. A small timing race or consumer-local reuse can affect exact counts; investigate unexpected duplicate exchanges without exposing credentials.

## 9. Validate cancellation and failure behavior

Use a separate disposable run:

- [ ] obtain credentials once, then keep the job active with a harmless wait;
- [ ] cancel the run before the next renewal and confirm no privileged work continues unexpectedly;
- [ ] inspect action post-step logs to see whether cleanup was attempted;
- [ ] where an ephemeral self-hosted runner permits out-of-band inspection, confirm the generated directory is gone after a normal job and destroy the runner regardless;
- [ ] simulate an OIDC/STS outage or remove effective `id-token: write` in another run and confirm the helper exits nonzero with a bounded, sanitized diagnostic;
- [ ] confirm a primary job failure is not replaced by a cleanup failure.

Cancellation is not credential revocation. Assume credentials already returned by STS remain usable until expiration, and assume cleanup may not run after forceful termination. Do not weaken IAM or runner isolation based on observed cleanup success.

## 10. Validate normal cleanup

- [ ] Confirm the action's post step runs on success and ordinary failure.
- [ ] On a disposable self-hosted runner, inspect the runner temporary directory out of band after the job and verify the generated action directory was removed.
- [ ] Confirm no generated config, metadata, cache, backend config, state, or plan was uploaded by artifact/cache steps.
- [ ] Terminate the ephemeral runner after the test even if all files appear removed.

GitHub-hosted runner destruction is the final isolation control; absence cannot be inspected from a later step in the same completed job.

## 11. Review and tear down

- [ ] Review CloudTrail for only the expected roles, audiences, session names, repositories/refs, operations, and refresh intervals.
- [ ] Verify the roles could not access resources outside the disposable scope.
- [ ] Save a redacted test report containing tool versions, dates, workflow/commit references, pass/fail outcomes, and non-secret event references.
- [ ] Delete the temporary workflow/branch and any job artifacts or caches.
- [ ] Delete disposable state objects/buckets and test resources.
- [ ] Remove or disable the test roles and OIDC trust configuration if they are not needed for another controlled run.
- [ ] Destroy the ephemeral self-hosted runner, if used.
- [ ] Treat any accidental credential or token disclosure as an incident: stop the job, remove public logs/artifacts, revoke or restrict affected access where possible, and preserve only sanitized evidence.

A completed checklist provides compatibility evidence for the tested versions and date. It does not expand the documented Linux same-job support boundary beyond the tested same-job-container case; separately launched/service/sibling/Kubernetes/remote containers and cross-job transfer remain unsupported.
