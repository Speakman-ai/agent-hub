---
name: aws-cli
description: >-
  General-purpose AWS CLI (v2) skill — query any AWS service, resolve
  profiles/regions, apply JMESPath filters, handle pagination, and (with
  explicit user confirmation) run write/mutating operations. TRIGGER when: the
  user mentions "AWS", an `aws ...` command, an ARN (arn:aws:…), an S3 URI
  (s3://…), asks about an AWS resource by service name (EC2, S3, IAM, Lambda,
  ECS, EKS, RDS, DynamoDB, CloudWatch, CloudFormation, Route53, SSM, Secrets
  Manager, KMS, SQS, SNS, EventBridge, Cost Explorer), or says "check my AWS
  account / region / profile". DO NOT TRIGGER on: Terraform questions (use the
  terraform skill); generic cloud-provider comparisons with no AWS specifics;
  Azure or GCP only; or "AWS" as a passing mention with no actionable AWS
  context. Prefer this skill over `aws-infra` for broad multi-service work;
  `aws-infra` is a narrower infra-audit layer.
category: integration
version: 1.0.0
keep-coding-instructions: true
---

# AWS CLI (General-Purpose)

Use this skill to interact with **any AWS service** via the `aws` CLI v2 —
read resources, filter with JMESPath, handle pagination, manage profiles and
SSO sessions, and (after confirmation) run write operations.

## Prerequisites

### AWS CLI v2

All scripts require **`aws` CLI v2** on `$PATH`.

- macOS: `brew install awscli`
- Linux: see `references/profiles-and-regions.md` → Install section
- Verify: `aws --version` (must show `aws-cli/2.x`)

Credentials must be configured in `~/.aws/credentials` or `~/.aws/config`
(or via environment variables / IAM role). See `references/profiles-and-regions.md`.

### jq (recommended)

Some reference snippets (manual pagination loops, sorted output) pipe through
**`jq`** for JSON filtering. Install if not already present:

- macOS: `brew install jq`
- Linux: `sudo apt-get install jq` / `sudo yum install jq`
- Verify: `jq --version`

Where `jq` is unavailable the same results can usually be achieved with
`--query` (JMESPath) and `--output text` — see `references/jmespath-recipes.md`.

---

## Safety Model — Read-Default, Write-on-Confirm

**Read operations** (list, describe, get, query) run immediately.

**Write / mutating operations** (create, delete, put, update, terminate,
modify, scale, rotate, enable, disable, tag, untag) **must be confirmed by
the user first** — show the exact command and the resources that will change.

**Destructive-specific rules:**
- Never run `delete`, `terminate`, `destroy`, `remove`, or `purge`
  without a user-typed confirmation *in the current turn*.
- For bulk operations (e.g. deleting all objects in a bucket), list affected
  resources first, then ask for confirmation.
- Always prefer `--dry-run` (where supported by the service) and show the
  plan before execution.

**Never print credentials.** Mask any string matching `AKIA[A-Z0-9]{16}`,
`ASIA[A-Z0-9]{16}`, or `aws_secret_access_key` patterns. See `_common.sh`.

> **This is a behavioural contract on the agent, not a runtime guard.**
> The wrapper scripts execute mutations the moment they are invoked — the
> agent is responsible for confirming with the user first.

---

## Quick Start — Identity & Profile

```bash
# Who am I? Which account/region/profile?
scripts/aws-whoami.sh                          # STS identity + resolved profile/region
scripts/aws-whoami.sh --profile staging        # target a named profile
scripts/aws-whoami.sh --region eu-west-1       # override region for this call
```

---

## Generic Query Helper

```bash
# Run any read command with profile/region baked in
scripts/aws-q.sh ec2 describe-instances        # returns JSON
scripts/aws-q.sh s3api list-buckets
scripts/aws-q.sh iam list-users

# Add a JMESPath --query filter
scripts/aws-q.sh ec2 describe-instances \
  --query 'Reservations[].Instances[].[InstanceId,State.Name,InstanceType]' \
  --output table

# Pass through arbitrary flags (profile/region are injected automatically)
scripts/aws-q.sh lambda list-functions --max-items 20
scripts/aws-q.sh logs describe-log-groups --log-group-name-prefix /aws/lambda
```

`scripts/aws-q.sh` prepends `--profile` and `--region` resolved from the
environment (see `references/profiles-and-regions.md`) and formats output.

---

## Profile & Region Resolution

Resolved in this order (see `scripts/_common.sh:resolve_profile()`):
1. `--profile <name>` flag passed to the script
2. `AWS_PROFILE` env var
3. `AWS_DEFAULT_PROFILE` env var
4. `default` (from `~/.aws/config`)

Region follows the same priority via `AWS_REGION` / `AWS_DEFAULT_REGION` /
profile's `region` key. **Every response must state the resolved
profile and region.**

Full details: `references/profiles-and-regions.md`

---

## SSO & Assume-Role

### Project-configured profiles (Agent Hub)

When `AGENT_HUB_AWS_PROFILE_NAMES` is set, this project has SSO profiles in Hub
Settings → Projects → **AWS SSO profiles**. `AWS_CONFIG_FILE` points at the
generated config — use `--profile <name>` on every script.

**Login workflow (interactive sessions):**

1. `scripts/aws-whoami.sh --profile <name>` — if credentials work, proceed.
2. If not, check status:
   `GET $AGENT_HUB_URL/api/projects/$PROJECT_ID/aws-sso/status?profile=<name>`
   (Bearer `$AGENT_HUB_API_KEY`).
3. If `loggedIn` is false, start browser-less SSO:
   `POST $AGENT_HUB_URL/api/projects/$PROJECT_ID/aws-sso/login`
   body `{"profile":"<name>"}` → give the user `loginUrl` to open; wait, then
   re-check status.
4. Run AWS reads via `scripts/aws-q.sh` with `--profile <name>`.

Ask the user which profile (dev, staging, prod, …) when ambiguous.

### Manual SSO (no Hub project config)

```bash
# Check if SSO session is active
aws sts get-caller-identity --profile <sso-profile> 2>&1 | grep -q "ExpiredToken" \
  && echo "Run: aws sso login --profile <sso-profile>"

# Assume a cross-account role
eval "$(aws sts assume-role \
  --role-arn arn:aws:iam::123456789012:role/MyRole \
  --role-session-name agent-session \
  --query 'Credentials.[AccessKeyId,SecretAccessKey,SessionToken]' \
  --output text | awk '{print "export AWS_ACCESS_KEY_ID="$1"\nexport AWS_SECRET_ACCESS_KEY="$2"\nexport AWS_SESSION_TOKEN="$3}')"
```

Full runbook: `references/sso-and-assume-role.md`

---

## JMESPath Quick Reference

```bash
# Filter instance IDs where state is running
aws ec2 describe-instances \
  --query 'Reservations[].Instances[?State.Name==`running`].InstanceId[]'

# Flatten and project multiple fields
aws ec2 describe-instances \
  --query 'Reservations[].Instances[].[InstanceId,PrivateIpAddress,Tags[?Key==`Name`].Value|[0]]'

# Sort by key (requires --output json + jq for ordering; JMESPath has no sort)
aws lambda list-functions \
  --query 'Functions[].{Name:FunctionName,Runtime:Runtime,Memory:MemorySize}' \
  | jq 'sort_by(.Name)'
```

Cheatsheet: `references/jmespath-recipes.md`

---

## Pagination

AWS CLI v2 **auto-paginates by default** — it follows all `NextToken` pages
and merges them into a single response. You rarely need to do anything special
for small-to-medium datasets.

Use `--no-paginate` to **disable** auto-pagination and return **only the first
page** (useful for quick checks or when you want to control paging yourself):

```bash
# First page only — fast, but may miss items on subsequent pages
aws ec2 describe-instances --no-paginate --output json
```

For manual page-by-page control:

```bash
aws ec2 describe-instances --max-items 50
# Use NextToken from the previous response:
aws ec2 describe-instances --max-items 50 --starting-token "<token>"
```

Details + loop patterns: `references/pagination-and-output.md`

---

## Service Reference

Key recipes for every major service: `references/common-services.md`

---

## Relationship to `aws-infra`

`aws-infra` is a **project-level** skill focused on **infrastructure
auditing** (EC2, S3, IAM, Lambda, ECS/EKS, RDS, CloudWatch, billing).
Load `aws-cli` for general-purpose work across any service; `aws-infra`
is a narrower, opinionated layer on top of the same CLI primitives.
Both can coexist; prefer `aws-cli` when the task spans multiple services
or doesn't fit the infra-audit frame.

---

## Available Scripts

| Script | Purpose |
|---|---|
| `scripts/aws-whoami.sh` | STS identity + resolved profile/region |
| `scripts/aws-q.sh` | Generic read-query helper with profile/region injection |
| `scripts/_common.sh` | Profile/region resolution, secret masking, error helpers |
