# AWS OIDC Setup for GitHub Actions Deploys

This doc walks through the one-time AWS + GitHub configuration required by the
`deploy-dev.yml` and `release-prod.yml` workflows. Everything below is applied
manually in the AWS console (or via Terraform/CLI — the JSON policies are
paste-ready).

## Overview

Both workflows authenticate to AWS **without long-lived access keys** by using
GitHub's OIDC identity provider to assume an IAM role scoped to this repo.
The role can do exactly three things:

1. `ec2:DescribeInstances` (to resolve instance IDs by Name tag)
2. `ssm:SendCommand` against the three Agent Hub EC2 instances, using only the
   `AWS-RunShellScript` document
3. `ssm:GetCommandInvocation` + `ssm:ListCommandInvocations` to poll command
   status

No other AWS permissions are granted. No IAM user credentials are ever issued.

## Step 1 — Register GitHub as an OIDC provider

One per AWS account. If another repo in this account already set this up, skip.

1. IAM → **Identity providers → Add provider**
2. Provider type: **OpenID Connect**
3. Provider URL: `https://token.actions.githubusercontent.com`
4. Audience: `sts.amazonaws.com`
5. Thumbprint: `6938fd4d98bab03faadb97b34396831e3780aea1`

(GitHub's docs note that AWS now validates the JWT against the IdP's live
certificates, making the thumbprint effectively a belt-and-suspenders value.
Keep it anyway.)

## Step 2 — Create the deploy IAM role

Create a new role (suggested name: `agent-hub-github-actions-deploy`) with
**Web identity** as the trusted entity, selecting the OIDC provider from step 1
and audience `sts.amazonaws.com`.

Replace the trust policy with the JSON below. This pins the trust to the
`Speakman-ai/agent-hub` repo, and only to the `main` branch or to any tag
matching `v*` (so tag-based prod deploys work while feature branches can't
assume the role).

### Trust policy

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": {
        "Federated": "arn:aws:iam::<ACCOUNT_ID>:oidc-provider/token.actions.githubusercontent.com"
      },
      "Action": "sts:AssumeRoleWithWebIdentity",
      "Condition": {
        "StringEquals": {
          "token.actions.githubusercontent.com:aud": "sts.amazonaws.com"
        },
        "StringLike": {
          "token.actions.githubusercontent.com:sub": [
            "repo:Speakman-ai/agent-hub:ref:refs/heads/main",
            "repo:Speakman-ai/agent-hub:ref:refs/tags/v*"
          ]
        }
      }
    }
  ]
}
```

Replace `<ACCOUNT_ID>` with the 12-digit AWS account number.

> **Note on `refs/tags/v*`:** No workflow in this repo currently runs from a
> tag ref — `release-prod.yml` is `workflow_dispatch` against `main`, so every
> OIDC `sub` claim today is `refs/heads/main`. The tag clause is forward-compat
> for a future workflow triggered by `on: push: tags: ['v*']`. Leaving it in
> now avoids having to coordinate an IAM policy change with that future work.

### Permissions policy

Attach an inline policy (suggested name: `agent-hub-deploy`) with the JSON
below. Replace `<ACCOUNT_ID>` and fill in the three instance IDs once the
instances exist.

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "DescribeInstances",
      "Effect": "Allow",
      "Action": "ec2:DescribeInstances",
      "Resource": "*"
    },
    {
      "Sid": "SendCommandToAgentHubInstances",
      "Effect": "Allow",
      "Action": "ssm:SendCommand",
      "Resource": [
        "arn:aws:ec2:us-east-2:<ACCOUNT_ID>:instance/<I-AGENT-HUB-SERVER>",
        "arn:aws:ec2:us-east-2:<ACCOUNT_ID>:instance/<I-AGENT-HUB-PROD>",
        "arn:aws:ec2:us-east-2:<ACCOUNT_ID>:instance/<I-AGENT-HUB-PROD-2>",
        "arn:aws:ssm:us-east-2::document/AWS-RunShellScript"
      ]
    },
    {
      "Sid": "ReadCommandResults",
      "Effect": "Allow",
      "Action": [
        "ssm:GetCommandInvocation",
        "ssm:ListCommandInvocations"
      ],
      "Resource": "*"
    }
  ]
}
```

Note: `ssm:GetCommandInvocation` does not support resource-level scoping and
requires `Resource: "*"`. Combined with the instance-scoped `ssm:SendCommand`,
this is safe — the role can only read invocations it was allowed to start.

## Step 3 — Ensure instances are SSM-managed

Each of the three EC2 instances must:

- Have the **SSM Agent** installed and running (Amazon Linux 2/2023 and recent
  Ubuntu AMIs ship with it; otherwise install per the AWS docs).
- Have an **instance profile** attached whose role includes the
  `AmazonSSMManagedInstanceCore` managed policy (so the SSM Agent can register
  with SSM).
- Be tagged `Name=agent-hub-server`, `Name=agent-hub-prod`, or
  `Name=agent-hub-prod-2` exactly. The workflows resolve instance IDs by this
  tag and fail if zero or multiple matches are found.

Verify with:

```sh
aws ssm describe-instance-information \
  --filters "Key=tag:Name,Values=agent-hub-server,agent-hub-prod,agent-hub-prod-2" \
  --query 'InstanceInformationList[].[InstanceId,Name,PingStatus]' \
  --output table
```

All three should show `PingStatus=Online`.

## Step 4 — Configure GitHub repo variables & secrets

Settings → Secrets and variables → Actions.

### Repository variables (plaintext)

| Name | Value | Required | Notes |
|------|-------|----------|-------|
| `AWS_DEPLOY_ROLE_ARN` | `arn:aws:iam::<ACCOUNT_ID>:role/agent-hub-github-actions-deploy` | yes | The role from step 2. |
| `AWS_REGION` | `us-east-2` | optional (defaults to `us-east-2`) | Override if instances move regions. |
| `DEPLOY_PATH` | `/home/agenthub/agent-hub` | optional (defaults to `/home/agenthub/agent-hub`) | Absolute path to the checkout on each EC2 instance. Set to `/home/ubuntu/agent-hub` or whatever applies if different. |

### Repository secrets

| Name | Required | Notes |
|------|----------|-------|
| `RELEASE_PAT` | yes (for release-prod.yml) | A **fine-grained personal access token** (or GitHub App installation token) scoped to `Speakman-ai/agent-hub` with `Contents: Read and write` permission. Used by the `release` job to push the version-bump commit + tag and to call `gh release create`. We require a PAT (instead of the default `GITHUB_TOKEN`) for two reasons: (1) `GITHUB_TOKEN` pushes cannot bypass branch protection on `main`, which blocks the version-bump commit; and (2) commits pushed with `GITHUB_TOKEN` do not re-trigger workflows, so CI would never run against the `chore(release): vX.Y.Z` commit. A known side effect of using a PAT is that the bump commit *does* re-trigger CI, which in turn would fire `deploy-dev.yml` via `workflow_run`. To prevent every prod release from also force-deploying dev, `deploy-dev.yml` explicitly skips commits whose message starts with `chore(release):`. |

**We picked a PAT over a GitHub App** for initial simplicity. When we add more
automated repo mutations, migrate to a GitHub App (e.g. `actions/create-github-app-token@v1`)
and remove `RELEASE_PAT`.

## Step 5 — First-deploy smoke test

1. In GitHub, run **Release & Deploy Prod** with `bump=patch` (or push a dummy
   commit to `main` to kick off **Deploy Dev** via the `workflow_run` trigger).
2. Watch the job logs. Each step logs the resolved instance ID, the SSM
   CommandId, and polls status every 10 seconds.
3. On success, hit `https://<host>/api/health` to confirm the new version is live.

## Runbook

### Rollout halted at prod-1

If `deploy-prod-1` fails, `deploy-prod-2` never runs (GitHub Actions `needs:`
halts on failure). The halt step emits a step summary explaining the failure.

**Recovery path:**

1. Inspect the failure in the job logs (stdout/stderr are dumped automatically).
2. Manually `ssh` to `agent-hub-prod` (via SSM Session Manager or bastion) and
   inspect `pm2 logs agent-hub`, `git status`, and `/api/health` directly.
3. Options:
   - **Roll forward**: fix the bug, cut a new patch release, re-run this
     workflow. prod-1 will deploy again; if healthy, prod-2 follows.
   - **Roll back**: SSH to prod-1 and `git checkout <previous-tag>`, then
     `pm2 restart agent-hub`. Do the same on prod-2 if it was already updated.
   - **Skip prod-1 for now**: re-run this workflow with only the `deploy-prod-2`
     job (Actions → re-run jobs → specific). Only do this if you've confirmed
     prod-1 is intentionally drained or removed from the load balancer.
4. After recovery, update the kanban "Incidents" column with a postmortem.

### Deploy-dev silently skipped

Because `deploy-dev.yml` is triggered by the CI workflow's `completed` event
and gated on `conclusion == 'success'`, a failed CI run produces a
`deploy-dev` run with status "Skipped". This is intentional — it's not an
error, it's the guard doing its job. Check the CI run for the actual failure.

### Wrong instance count

If `resolve` fails with "Expected exactly 1 running instance", either:

- The Name tag is missing/misspelled on the target instance, or
- Multiple instances share the tag (common after a blue/green test).

Fix by re-tagging and re-running the workflow.
