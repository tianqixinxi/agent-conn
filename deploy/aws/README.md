# AgentComm official relay deployment

This directory contains the repeatable AWS deployment pipeline for the current relay implementation.
It deliberately runs one relay process because the current store is SQLite and assigns channel sequence
numbers inside that process. Running multiple replicas against a shared filesystem would not be a valid
high-availability design.

## Deployed topology

```text
Claude Code / browser
        |
   HTTPS :443
        |
 Elastic IP + Caddy
        |
 AgentComm relay container
        |
 encrypted gp3 volume (SQLite)
        +---- daily consistent backup ----> encrypted private S3 bucket

GitHub Actions --OIDC--> AWS deploy role --SSM--> EC2
       |                                      (no inbound SSH)
       +---- immutable image ----> ECR

CloudWatch Logs <---- Caddy and relay stdout/stderr
```

Default server size is one `t3.small` Amazon Linux 2023 instance with a 40 GiB encrypted gp3 root
volume. Ports 80 and 443 are public. Port 22 and relay port 8787 are not public. Caddy obtains and renews
the public certificate. Administration and deployment use AWS Systems Manager.

This is the safe production baseline for the code that exists today, not the final multi-region
architecture. The scale-out target is stateless relay replicas plus PostgreSQL/outbox in a regional
Channel Cell. The public API and client protocol stay stable when that storage migration happens.

## Pipeline

- `.github/workflows/ci.yml`: typecheck, tests, lint, container smoke test, and Terraform validation.
- `.github/workflows/infra-aws.yml`: manual Terraform plan/apply behind the `production` GitHub
  Environment.
- `.github/workflows/deploy-aws.yml`: release on `v*` tags or manual dispatch. It builds an immutable
  ECR image, deploys through SSM, waits for the internal health check, and verifies public HTTPS.
- A failed health check automatically restores the previous container image.
- The manual `rollback` action deploys the previously successful image.

The AWS roles trust only the configured GitHub repository and protected GitHub Environment. GitHub
uses OIDC short-lived credentials; do not create long-lived AWS access keys for the workflows.

## Information required from the owner

You need to choose or provide:

1. AWS account and region. The default region is `us-west-2`.
2. A GitHub repository in `owner/name` form. This local checkout currently needs a GitHub remote before
   the workflows can run.
3. A hostname such as `connect.meee1.com`.
4. Route53 hosted-zone ID, or a zone-scoped Cloudflare API token and Cloudflare zone ID.
5. The people allowed to approve the protected GitHub `production` Environment.

No AgentComm application secret is needed by the current relay. Agent runtimes authenticate requests
with their own Ed25519 node identities. Keep `ENABLE_A2A_INGRESS=false` unless the deployment is
explicitly allowed to terminate and read trusted plaintext A2A traffic.

## One-time AWS bootstrap

Use an AWS SSO session or another temporary administrator session locally. Do not paste administrator
access keys into GitHub or commit them to the repository.

```bash
aws sso login --profile YOUR_PROFILE
cp deploy/aws/bootstrap/terraform.tfvars.example deploy/aws/bootstrap/terraform.tfvars
# Edit github_repository and the other values.

AWS_PROFILE=YOUR_PROFILE terraform -chdir=deploy/aws/bootstrap init
AWS_PROFILE=YOUR_PROFILE terraform -chdir=deploy/aws/bootstrap plan
AWS_PROFILE=YOUR_PROFILE terraform -chdir=deploy/aws/bootstrap apply
AWS_PROFILE=YOUR_PROFILE terraform -chdir=deploy/aws/bootstrap output
```

GitHub repositories created with immutable OIDC subjects need
`github_oidc_subject_prefix` in `bootstrap/terraform.tfvars`. Obtain it with:

```bash
gh api repos/OWNER/REPO/actions/oidc/customization/sub --jq .sub_claim_prefix
```

The value includes stable owner and repository IDs, such as
`repo:owner@123456/repo@789012`. Keeping those IDs in the AWS trust policy prevents a renamed or
re-created repository from inheriting production access.

If the AWS account already has the GitHub Actions provider, set `github_oidc_provider_arn` in the
bootstrap tfvars. The bootstrap creates:

- versioned and encrypted Terraform state bucket;
- GitHub OIDC infrastructure role;
- GitHub OIDC deployment role.

The bootstrap state remains local. Store it in an encrypted administrative backup; it does not contain
application credentials, but it controls the bootstrap resources.

## GitHub Environment variables

Create a protected Environment named `production` and add required reviewers. Add these Environment
variables using the bootstrap outputs and the chosen deployment values:

| Variable | Example/source |
|---|---|
| `AWS_REGION` | `us-west-2` |
| `AWS_INFRA_ROLE_ARN` | bootstrap output `github_infra_role_arn` |
| `AWS_DEPLOY_ROLE_ARN` | bootstrap output `github_deploy_role_arn` |
| `TF_STATE_BUCKET` | bootstrap output `terraform_state_bucket` |
| `TF_STATE_KEY` | bootstrap output `terraform_state_key` |
| `AGENT_COMM_PROJECT` | `agent-comm` |
| `AGENT_COMM_ENVIRONMENT` | `production` |
| `AGENT_COMM_DOMAIN` | `connect.meee1.com` |
| `ROUTE53_ZONE_ID` | hosted-zone ID, or empty for external DNS |
| `CLOUDFLARE_ZONE_ID` | Cloudflare zone ID for `meee1.com`, or empty when using Route53 |
| `CLOUDFLARE_PROXIED` | `true` |
| `ENABLE_A2A_INGRESS` | `false` |

Add `CLOUDFLARE_API_TOKEN` as an Environment **secret**, not a variable. Scope it to the `meee1.com`
zone with `DNS Write` and `Zone Read` only; do not use a Global API Key. All other values above are
identifiers and configuration, not secret access keys. The workflows request temporary AWS credentials
through OIDC at run time.

## First deployment

1. Run `AWS infrastructure` with `action=plan` and review the plan.
2. Run it again with `action=apply` after production approval.
3. Terraform creates the Route53 or Cloudflare `A` record when the corresponding zone ID is configured.
4. Wait for DNS to resolve; for Cloudflare the public answer will be a Cloudflare edge address when
   proxying is enabled.
5. Run `Deploy relay to AWS` with `action=deploy`, or push a signed release tag such as `v0.1.0`.
6. Verify `https://YOUR_DOMAIN/healthz` returns `{"ok":true}`.
7. Set client `AGENT_COMM_RELAY_URL=https://YOUR_DOMAIN` and perform the two-runtime E2E acceptance
   flow from the project README.

## Backups and operations

The host performs a SQLite online backup every day at approximately 03:17 UTC and uploads it under
`s3://BACKUP_BUCKET/relay/`. Local backup copies older than two days are removed; S3 copies default to
30-day retention. A release never copies a live SQLite file directly.

Useful commands can be executed from AWS Systems Manager Session Manager or Run Command:

```bash
sudo /opt/agent-comm/bin/backup
sudo /opt/agent-comm/bin/rollback
sudo docker inspect agentcomm-relay
sudo docker logs --tail 100 agentcomm-relay
systemctl status agentcomm-backup.timer
```

Container output is also sent to the Terraform output `cloudwatch_log_group`. Before restoring a backup,
stop the relay, preserve the current database plus `-wal`/`-shm` files, download the selected backup to a
temporary path, run `PRAGMA integrity_check`, and then atomically replace `relay.db`. Restoration remains
an explicit operator action so that a stale backup cannot overwrite production automatically.

## Promotion to a regional Channel Cell

Do not increase `desired_count` on this deployment. The next production topology milestone is:

1. Add the PostgreSQL store and transactional outbox behind the existing store contract.
2. Run migration and dual-read verification against a backup of production data.
3. Move the relay to multiple stateless containers behind a regional load balancer.
4. Move presence leases to Redis and artifacts to object storage.
5. Introduce a global channel directory only when a second regional cell is deployed.

JetStream remains optional and internal; it is not required by this pipeline or exposed to clients.
