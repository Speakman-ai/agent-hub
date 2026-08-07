# Read-only IAM policy for Agent Hub infrastructure monitoring

Policy version: 3

Agent Hub's Infrastructure module polls CloudWatch and the per-service describe
APIs on a schedule. This directory publishes exactly what to grant it, in three
interchangeable formats, so you can diff a change to that grant rather than take
our word for it:

| File | What it is |
| --- | --- |
| `agent-hub-monitoring-policy.json` | The permission policy. The source of truth. |
| `agent-hub-monitoring-role.tf` | Terraform: the role, its trust policy, and a customer-managed policy that reads the JSON verbatim. |
| `agent-hub-monitoring-role.yaml` | CloudFormation: the same role and policy, restated inline. |

`server/infra/infra-iam-actions.ts` lists every action the collectors call, and
`server/infra/infra-iam-policy.test.ts` fails the build if the published policy
and that list ever diverge in either direction. A collector cannot start calling
an API without this policy gaining the action, and the policy cannot quietly
gain an action no collector calls.

## Do not attach `ReadOnlyAccess`

`arn:aws:iam::aws:policy/ReadOnlyAccess` is not metadata-only. It carries
data-plane reads (verified against the AWS managed-policy reference, version
v188):

- `s3:Get*` — which includes `s3:GetObject`, so it reads object bodies
- `dynamodb:Get*`, plus explicit `dynamodb:Query`, `dynamodb:Scan` and
  `dynamodb:PartiQLSelect`
- `logs:FilterLogEvents` — log message content, not just metadata
- `rds:Download*` — `DownloadDBLogFilePortion` and `DownloadCompleteDBLogFile`

Granting that to a monitoring integration hands it the ability to read your
actual data. Refusing is the correct response. The policy here grants none of
those, and the doc test asserts it — including through wildcards, so a future
`s3:Get*` in our policy would fail the same way an explicit `s3:GetObject`
would.

## Do not attach `ViewOnlyAccess` either

`arn:aws:iam::aws:policy/job-function/ViewOnlyAccess` errs the other way, in two
specific places (verified against the managed-policy reference, version v45):

1. **Its whole CloudWatch grant is `cloudwatch:Get*` and `cloudwatch:List*`.**
   There is no `cloudwatch:Describe*`, so `cloudwatch:DescribeAlarms` is
   missing. Agent Hub reads your existing CloudWatch alarms to show their state
   beside its own, because operators diff the two. On `ViewOnlyAccess` alone
   that read is `AccessDenied`.
2. **It carries no `ce:`, `health:`, `compute-optimizer:` or `servicequotas:`
   actions at all.** Three of those four matter here: Cost Explorer drives the
   spend trends, Health drives AWS-side incident events, and Service Quotas
   turns raw usage metrics into headroom percentages. (`compute-optimizer:` is
   absent from `ViewOnlyAccess` and also absent from this policy — nothing in
   Agent Hub calls it.)

It is also missing `tag:GetResources` (scope tag filters), `lambda:Get*` (so no
`GetFunctionConfiguration`), and `s3:GetBucketLocation` / `s3:GetBucketTagging` /
`s3:GetMetricsConfiguration`.

## What this policy grants, and why

Every statement is its own `Sid`. Delete a block to opt out of a capability and
you know precisely what stops working.

| `Sid` | Actions | What breaks without it |
| --- | --- | --- |
| `AgentHubCallerIdentity` | `sts:GetCallerIdentity` | Nothing — AWS allows this for every identity and ignores an explicit `Deny`. It is here as documentation of a call we make, not as a grant that changes anything. |
| `AgentHubResourceInventory` | `ec2:Describe*` (regions, instances, instance status, volumes, NAT gateways, tags), `ecs:List*`/`Describe*` (clusters, services), `rds:DescribeDBInstances`/`DescribeDBClusters`, `elasticloadbalancing:Describe*` (load balancers, target groups, target health, tags), `lambda:ListFunctions`/`GetFunctionConfiguration`/`ListTags`, `s3:ListAllMyBuckets`/`GetBucketLocation`/`GetBucketTagging`/`GetMetricsConfiguration` | The hourly inventory sync. Nothing appears in the resource browser and the metric collector has no query list to build from. |
| `AgentHubMetricRead` | `cloudwatch:GetMetricData`, `GetMetricStatistics`, `ListMetrics` | All charts and all alert evaluation. |
| `AgentHubAlarmRead` | `cloudwatch:DescribeAlarms` | Your own CloudWatch alarm state stops appearing beside Agent Hub's. |
| `AgentHubTagRead` | `tag:GetResources` | Tag filters on a collection scope. |
| `AgentHubQuotaRead` | `servicequotas:ListServiceQuotas`, `GetServiceQuota` | Quota headroom becomes a raw number with no ceiling to compare against. |
| `AgentHubCostExplorerRead` | `ce:GetCostAndUsage` | Spend trends. **Opt-in** — Cost Explorer bills $0.01 per request with every pagination page counted and no free tier, which is why Agent Hub polls it at most three times a day behind a cache. |
| `AgentHubHealthRead` | `health:DescribeEvents`, `DescribeEventDetails`, `DescribeAffectedEntities` | AWS-side incidents and scheduled changes. **Opt-in** — the Health API needs a Business Support+, Enterprise Support or Unified Operations plan (legacy Business / Enterprise On-Ramp / Enterprise also work). Without one it raises `SubscriptionRequiredException`, not `AccessDenied`. |

Drop the last two statements entirely if you do not want them; nothing else
depends on them.

### Why `Resource: "*"`

Most of these actions do not support resource-level permissions — the Service
Authorization Reference leaves their "Resource types" column empty, which means
the policy must specify `"*"`. That covers every `ec2:Describe*`, every
`elasticloadbalancing:Describe*`, `tag:GetResources`,
`cloudwatch:GetMetricStatistics`, `ecs:ListClusters`, `ecs:ListServices`,
`lambda:ListFunctions`, `s3:ListAllMyBuckets`, `health:DescribeEvents` and
`servicequotas:ListServiceQuotas`.

A handful of the rest *are* scopable (`cloudwatch:DescribeAlarms` to alarm ARNs,
`ecs:DescribeServices` to service ARNs, `s3:GetBucketTagging` and
`s3:GetMetricsConfiguration` to bucket ARNs,
`lambda:GetFunctionConfiguration` to function ARNs). Splitting them into a
narrower statement buys little — the account-wide discovery calls in the same
policy already see everything — and adds a large breakage surface as your
resources change. If you want a real compensating control, use
`aws:RequestedRegion` rather than the `Resource` element.

**If you add an `aws:RequestedRegion` condition, exempt these:** Cost Explorer
and Health are global services reached at `us-east-1`, `s3:ListAllMyBuckets` is
account-level, and `ec2:DescribeRegions` is what discovers the region list in
the first place. A naive region allowlist breaks all four. Either put them in a
second, unconditioned statement or include `us-east-1` in the allowlist.

## Cross-account setup

### 1. Get your external ID

Open the project in Agent Hub → **Settings → Projects → AWS**. Every project has
an **External ID (generated)** field on its assume-role profiles. Copy it.

Agent Hub generates that value, it is unique to the project, and it is
read-only. That is deliberate and it is the whole security property, not a UI
decision: one Agent Hub deployment holds one identity and assumes roles for
every project on the box. If an operator could type the external ID, they could
point a role profile at another tenant's monitoring role and satisfy its trust
policy. A value they cannot author is what keeps that shut. AWS says the same
thing in its confused-deputy guidance — the external ID "must be unique among
Example Corp's customers and controlled by Example Corp, not its customers."

It is **not a secret**. Anyone who can read the role can read the condition. Its
job is uniqueness per tenant, not confidentiality, so there is nothing to
protect when you paste it into a template or a pull request.

### 2. Apply the role

Terraform:

```hcl
module "agent_hub_monitoring" {
  source = "./agent-hub-monitoring"

  agent_hub_account_id         = "123456789012"
  agent_hub_collector_role_arn = "arn:aws:iam::123456789012:role/AgentHubCollector"
  agent_hub_external_id        = "agent-hub-8f14e45f-ceea-467a-9c1e-6b1e5f8a0d2c"
}
```

CloudFormation:

```
aws cloudformation deploy \
  --template-file agent-hub-monitoring-role.yaml \
  --stack-name agent-hub-monitoring \
  --capabilities CAPABILITY_NAMED_IAM \
  --parameter-overrides \
      AgentHubCollectorRoleArn=arn:aws:iam::123456789012:role/AgentHubCollector \
      AgentHubExternalId=agent-hub-8f14e45f-ceea-467a-9c1e-6b1e5f8a0d2c
```

Both templates pin the trust to a single collector role rather than to the
whole Agent Hub account. `"Principal": {"AWS": "<account-id>"}` on its own
trusts every user and role in that account; the `aws:PrincipalArn` condition
narrows it to one. Use the **role** ARN, not the assumed-role session ARN —
`aws:PrincipalArn` reports the role for an assumed session.

### 3. Verify the external ID is actually enforced

This is the step people skip, and it is the one that matters. A trust policy
that names an external ID but does not require it gives you nothing.

```
# Must FAIL with AccessDenied.
aws sts assume-role \
  --role-arn arn:aws:iam::<your-account>:role/AgentHubMonitoring \
  --role-session-name external-id-check

# Must SUCCEED.
aws sts assume-role \
  --role-arn arn:aws:iam::<your-account>:role/AgentHubMonitoring \
  --role-session-name external-id-check \
  --external-id agent-hub-8f14e45f-ceea-467a-9c1e-6b1e5f8a0d2c
```

If the first call succeeds, the trust policy is wrong — do not register the role
in Agent Hub until it fails. AWS's own guidance to third parties is to refuse to
store a customer's role ARN until an assume without the correct external ID
fails.

The most common cause is `StringEqualsIfExists` instead of `StringEquals`. The
`...IfExists` operators evaluate to **true when the key is absent**, so a call
supplying no external ID sails through. Both templates here use plain
`StringEquals`; if you hand-write the trust policy, do the same.

### 4. Register the role in Agent Hub

Back in **Settings → Projects → AWS**, add an assume-role profile with the role
ARN the template output, then designate it as the project's **monitoring
profile**. The monitoring profile is what unattended collection runs as, and it
can never be an IAM Identity Center profile — an SSO token caches under a user's
home directory and expires with nobody around to re-run `aws sso login`, so
collection would stop within hours.

## Changing the policy

1. Add or remove the action in `server/infra/infra-iam-actions.ts`.
2. Update all three files in this directory to match.
3. Bump `INFRA_IAM_POLICY_VERSION` and the **Policy version** line at the top of
   this file.
4. `cd server && npx vitest infra/infra-iam-policy.test.ts`.

Operators who applied an earlier version see the new one in the diff, which is
the entire point of committing it here rather than pasting it into a support
thread.
