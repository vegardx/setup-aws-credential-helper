# Service emulator smoke test

Moto is the selected secretless service emulator for the acceptance smoke test.
The test pulls the moving `motoserver/moto:latest` image and logs its resolved
version, manifest digest, architecture-specific image ID, runner OS, and Node
architecture on every run.

The common comparison spike ran on native GitHub-hosted Ubuntu 24.04 x64 and
arm64 runners. Both candidates passed controlled OIDC/STS credential generation,
four distinct `credential_process` profiles, AWS SDK v3 and AWS CLI S3 CRUD,
and CloudFormation creation of a real SQS queue. The differentiating requirement
was a CloudFormation update that changed the queue visibility timeout and was
then verified independently through SQS:

| Candidate | x64 | arm64 | Result |
| --- | --- | --- | --- |
| Moto 5.2.2.dev0 | pass | pass | Selected; full queue create/update/delete effects passed |
| Floci 1.5.33 | fail | fail | Queue update rolled back because it attempted to recreate the named queue |

Observed cold-pull/startup times were 14.0 s (Moto x64), 22.2 s (Moto arm64),
6.2 s (Floci x64), and 14.2 s (Floci arm64). Probe times were 12.5 s, 10.8 s,
10.2 s, and 9.1 s respectively. All four runs removed their containers
successfully in 148–299 ms. Both images resolved stable multi-architecture
manifest digests and ran natively. All services used one random loopback
endpoint; S3 required path-style addressing.

Run the retained smoke test with:

```bash
npm run test:emulator
```

It requires Docker and the AWS CLI, but no AWS credentials, GitHub OIDC
permission, license token, or mounted Docker socket inside the emulator.
