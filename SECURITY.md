# Security policy

## Supported versions

Security fixes are provided for the latest supported major release line. Before a stable release exists, only the current `main` branch is supported. Users should pin the action to a reviewed, immutable full commit SHA and update deliberately when a fix is published.

## Report a vulnerability privately

Do not disclose a suspected vulnerability in a public issue, discussion, pull request, workflow log, or other public channel.

Use GitHub's private vulnerability reporting for this public repository:

1. Open the repository's **Security** tab.
2. Choose **Report a vulnerability** under **Private vulnerability reporting**.
3. Submit the advisory form at:
   <https://github.com/vegardx/setup-aws-credential-helper/security/advisories/new>

If GitHub does not offer that form to you, open a minimal public issue asking the maintainer to enable a private security contact. Do not include vulnerability details, secrets, tokens, account identifiers, or exploit output in that issue.

Include, when safely possible:

- affected commit or release;
- impact and required attacker access;
- reproducible steps using redacted or synthetic data;
- relevant runner, GitHub deployment, AWS partition, and consumer versions;
- a proposed mitigation, if known.

Never send real GitHub OIDC request bearer tokens, JWTs, AWS access keys/session tokens, private generated configs, cache records, Terraform/OpenTofu plans, or unredacted account information. The maintainer will acknowledge the report, coordinate investigation and remediation, and credit reporters who want attribution. Response and release timing depends on severity and maintainer availability; please allow a reasonable private remediation period before disclosure.

## Security assumptions

This action is intended for trusted code in a Linux GitHub Actions job, including the tested case where setup and consumers share one `jobs.<job>.container`. The job—not this helper—is the security boundary. Code running as the same job user may be able to request OIDC tokens, invoke the helper, or read issued temporary credentials. File modes and best-effort cleanup do not defend against malicious same-user code or revoke credentials. Separately launched, service, sibling, Kubernetes, remote, and cross-job containers are outside the support boundary.

Use least-privilege IAM roles, narrowly scoped OIDC trust conditions, short practical session durations, reviewed and pinned workflow dependencies, and ephemeral runners. Never execute an untrusted pull-request head in a privileged OIDC job. Repository offline CI is intentionally secretless and proves process/API compatibility only; it does not prove real GitHub OIDC longevity, AWS JWT signature validation, IAM trust or permissions boundaries, role duration enforcement, or rejection of truly expired AWS credentials. See the README's [security model](README.md#security-model) for the complete operating guidance.

Reports about unsupported platforms or documented same-user access are normally compatibility or hardening requests rather than vulnerabilities, but report privately if you believe they enable impact outside these stated assumptions.
