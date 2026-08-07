# Ingesting AWS Health events with EventBridge

Agent Hub's Infrastructure module shows AWS-side incidents and scheduled changes
— the same events you see on your AWS Health Dashboard — on the project
timeline. They arrive by **push**: you create an EventBridge rule in your own
AWS account that forwards `aws.health` events to an Agent Hub ingest endpoint.

Two things follow from that, and they are the reason this guide exists rather
than a "connect AWS" button:

- **Setup is entirely operator-performed.** Agent Hub creates nothing in the
  monitored account. It does not assume a role for this, does not call the
  Health API, and cannot create the rule for you. Everything below runs under
  your own credentials.
- **The ingest side is write-only.** The token you mint identifies exactly one
  project and grants no read, query, or management access to the Hub.

The full request/response shapes for every endpoint here are in the generated
OpenAPI reference: [`docs/api/openapi.yaml`](../api/openapi.yaml) (tag
**Infrastructure**).

## Placeholders used throughout

| Placeholder      | Meaning                                                                            |
| ---------------- | ---------------------------------------------------------------------------------- |
| `<hub-base-url>` | Public HTTPS base URL of your Agent Hub deployment, e.g. `https://hub.example.com` |
| `<project-id>`   | Project slug in Agent Hub, e.g. `agent-hub`                                        |
| `<account-id>`   | The 12-digit AWS account id you are monitoring                                     |
| `<region>`       | The AWS Region the rule and API destination live in, e.g. `us-east-1`              |

The shell snippets assume these are exported:

```bash
export HUB="<hub-base-url>"
export PROJECT="<project-id>"
export ACCOUNT="<account-id>"
export REGION="<region>"
```

> **The ingest endpoint must be reachable from AWS over public HTTPS.**
> EventBridge API destinations only support public domain names with publicly
> trusted certificates. A Hub that is only reachable on a VPN, a private subnet,
> or with a self-signed certificate cannot be an API destination target.

## 1. Why EventBridge, and not the Health API

The AWS Health API (`health:DescribeEvents` and friends) is gated on a support
plan: Business Support+, Enterprise Support, or Unified Operations (legacy
Business / Enterprise On-Ramp / Enterprise also work). An account without one
gets `SubscriptionRequiredException` — not `AccessDenied`, so no amount of IAM
tuning fixes it.

EventBridge delivery of the _same_ Health events is available to **every** AWS
customer at no additional cost. So the push path is the broadly usable one, and
for a Basic- or Developer-tier account it is the only one that works at all.

The load-bearing consequence: an account on a lesser support plan cannot call
`DescribeEvents` to backfill or re-fetch an event by ARN, so **the EventBridge
payload has to be self-sufficient**. Agent Hub's parser never assumes a
follow-up lookup is possible.

`DescribeEvents` may later be added as an **optional enrichment** for Business
Support+ accounts behind capability detection — a nicer description, richer
affected-entity lists. It is explicitly _not_ required, and nothing in this
guide depends on it. If you already grant `health:*` reads through the
[monitoring IAM policy](aws-monitoring-iam/README.md), that is orthogonal to
this setup: the timeline is fed by the rule below either way.

## 2. The event pattern

This is the exact literal the rule must use. Copy it verbatim:

```json
{ "source": ["aws.health"], "detail-type": ["AWS Health Event", "AWS Health Abuse Event"] }
```

> **`source` must match exactly. A wildcard silently matches nothing.** AWS
> documents this explicitly: "To receive both event types, your rule must use
> the `"source": [ "aws.health"]` value. Wildcards, such as
> `"source": [ "aws.health*"]` won't match the pattern to monitor for any
> events." This is the single most common setup failure, because the rule is
> created successfully, reports `ENABLED`, and simply never fires. There is no
> error anywhere to find.

`AWS Health Event` covers both account-specific events (a scheduled EC2 update,
an action-required change) and public events (a Regional service issue on the
AWS Health Dashboard). `AWS Health Abuse Event` covers abuse reports. Agent Hub
rejects any envelope whose `source` is not `aws.health` or whose `detail-type`
is neither of these two — see [troubleshooting](#12-troubleshooting).

You can narrow further on `detail.eventScopeCode` (`PUBLIC` or
`ACCOUNT_SPECIFIC`) if you only want one class, but start with the pattern
above and filter later.

## 3. Mint the ingest token

In Agent Hub: **Infrastructure → Overview → AWS Health panel → Create ingest
token**. Or via the API (Admin role):

```bash
curl -X POST "$HUB/api/projects/$PROJECT/infra/health-ingest" \
  -H "x-api-key: $ADMIN_KEY"
```

The `201` response carries the plaintext token **exactly once**, along with the
ingest path and the event pattern so the UI can offer copy buttons:

```json
{
  "token": "ahhealth_XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
  "info": {
    "projectId": "<project-id>",
    "tokenPrefix": "ahhealth_XXXXXXXX",
    "createdAt": 1786060800000,
    "rotatedAt": null,
    "revokedAt": null,
    "lastUsedAt": null
  },
  "ingestPath": "/api/infra/health/ingest",
  "eventPattern": {
    "source": ["aws.health"],
    "detail-type": ["AWS Health Event", "AWS Health Abuse Event"]
  }
}
```

Only `sha256(token)` is stored — the plaintext is never retrievable again. Keep
it somewhere you can paste it into the EventBridge connection in the next step:

```bash
export TOKEN="ahhealth_XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX"
```

### Token facts

- **One token per project.** Re-running the `POST` **rotates**: it mints a fresh
  plaintext and invalidates the previous hash immediately, with no grace window.
  Rotating also clears a prior revocation.
- **Write-only.** It authenticates Health ingest and nothing else. It cannot
  read events, list projects, or call any other Agent Hub API.
- **Identity comes from the token, never the body.** The ingest request body
  never names a project, so a delivery cannot be pointed at someone else's
  timeline by editing the payload.
- **Revoke** with `DELETE /api/projects/<project-id>/infra/health-ingest`. That
  stops ingest and keeps the events already stored.

## 4. Create the EventBridge connection

A **connection** holds the credential EventBridge presents to the endpoint.
Agent Hub authenticates with a bearer token, and EventBridge's `API_KEY`
authorization type is how you send one: despite the name, `API_KEY` sets an
**arbitrary header of your choosing**, so `ApiKeyName=Authorization` with
`ApiKeyValue="Bearer ahhealth_…"` produces exactly the header the endpoint
wants.

```bash
aws events create-connection \
  --name agent-hub-health \
  --description "Agent Hub AWS Health ingest" \
  --authorization-type API_KEY \
  --auth-parameters "{
    \"ApiKeyAuthParameters\": {
      \"ApiKeyName\": \"Authorization\",
      \"ApiKeyValue\": \"Bearer $TOKEN\"
    }
  }" \
  --region "$REGION"
```

EventBridge stores the value as a Secrets Manager secret through a
service-linked role it creates on first use; the token is not readable back out
of the connection.

Wait for the connection to reach `AUTHORIZED` before creating the API
destination — AWS calls this out explicitly, and a destination created against a
still-`CREATING` connection is a confusing failure:

```bash
aws events describe-connection \
  --name agent-hub-health \
  --region "$REGION" \
  --query 'ConnectionState' --output text
# AUTHORIZED
```

Record the ARN for the next step:

```bash
export CONNECTION_ARN=$(aws events describe-connection \
  --name agent-hub-health --region "$REGION" \
  --query 'ConnectionArn' --output text)
```

### If a proxy in front of the Hub eats `Authorization`

Agent Hub also accepts the token in a dedicated header. Use
`ApiKeyName=X-AgentHub-Health-Token` and `ApiKeyValue=ahhealth_…` (the raw
token, no `Bearer` prefix) instead. Both headers are equivalent to the endpoint;
pick one.

## 5. Create the API destination

```bash
aws events create-api-destination \
  --name agent-hub-health \
  --description "Agent Hub AWS Health ingest" \
  --connection-arn "$CONNECTION_ARN" \
  --invocation-endpoint "$HUB/api/infra/health/ingest" \
  --http-method POST \
  --region "$REGION"

export DESTINATION_ARN=$(aws events describe-api-destination \
  --name agent-hub-health --region "$REGION" \
  --query 'ApiDestinationArn' --output text)
```

`--invocation-rate-limit-per-second` is optional and defaults to **300**. Leave
it alone: a busy account sees a handful of Health events a day, and setting the
rate _below_ your event volume is what creates an undeliverable backlog, not
above it.

## 6. Create the IAM role EventBridge assumes

`put-targets` **requires** a `RoleArn` for an API destination target —
EventBridge assumes this role to invoke the destination. IAM is global, so
create the role once and reuse the same ARN for every Region's rule.

Trust policy (`trust-policy.json`):

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": { "Service": "events.amazonaws.com" },
      "Action": "sts:AssumeRole"
    }
  ]
}
```

Permission policy (`invoke-policy.json`). AWS documents the grant as
`events:InvokeApiDestination` on `arn:aws:events:*:*:api-destination/*`; scoping
it to the one destination you just created is strictly better and costs nothing:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "InvokeAgentHubHealthDestination",
      "Effect": "Allow",
      "Action": "events:InvokeApiDestination",
      "Resource": "arn:aws:events:<region>:<account-id>:api-destination/agent-hub-health/*"
    }
  ]
}
```

The trailing `/*` is not optional — an API destination ARN ends in a
service-generated unique id (`api-destination/<name>/<unique-id>`), so an ARN
without it matches nothing.

```bash
aws iam create-role \
  --role-name AgentHubHealthInvokeRole \
  --assume-role-policy-document file://trust-policy.json

aws iam put-role-policy \
  --role-name AgentHubHealthInvokeRole \
  --policy-name InvokeAgentHubHealthDestination \
  --policy-document file://invoke-policy.json

export ROLE_ARN="arn:aws:iam::$ACCOUNT:role/AgentHubHealthInvokeRole"
```

## 7. Create the rule and attach the target

The rule goes on the **default** event bus — AWS service events are delivered
there and nowhere else, so do not pass `--event-bus-name`.

```bash
aws events put-rule \
  --name agent-hub-aws-health \
  --description "Forward AWS Health events to Agent Hub" \
  --state ENABLED \
  --event-pattern '{"source":["aws.health"],"detail-type":["AWS Health Event","AWS Health Abuse Event"]}' \
  --region "$REGION"
```

```bash
aws events put-targets \
  --rule agent-hub-aws-health \
  --region "$REGION" \
  --targets "[
    {
      \"Id\": \"agent-hub-health-ingest\",
      \"Arn\": \"$DESTINATION_ARN\",
      \"RoleArn\": \"$ROLE_ARN\"
    }
  ]"
```

A successful call returns `{"FailedEntryCount": 0, "FailedEntries": []}`. A
non-zero `FailedEntryCount` names the reason per entry — most often the role is
missing `events:InvokeApiDestination`, or the caller lacks `iam:PassRole` for
the role being passed.

**Optional hardening.** Add a dead-letter queue and an explicit retry policy to
the target so an event that cannot be delivered within the retry window is
captured rather than dropped:

```json
{
  "Id": "agent-hub-health-ingest",
  "Arn": "<destination-arn>",
  "RoleArn": "<role-arn>",
  "RetryPolicy": { "MaximumRetryAttempts": 185, "MaximumEventAgeInSeconds": 86400 },
  "DeadLetterConfig": { "Arn": "arn:aws:sqs:<region>:<account-id>:agent-hub-health-dlq" }
}
```

Those `RetryPolicy` numbers are the defaults, restated so they are visible. The
queue needs a resource policy allowing `events.amazonaws.com` to `sqs:SendMessage`.

## 8. Verify

Three checks, cheapest first.

**a. The pattern matches.** `test-event-pattern` is offline and free — it never
touches your rule:

```bash
aws events test-event-pattern \
  --event-pattern '{"source":["aws.health"],"detail-type":["AWS Health Event","AWS Health Abuse Event"]}' \
  --event "{
    \"id\": \"1\",
    \"source\": \"aws.health\",
    \"detail-type\": \"AWS Health Event\",
    \"account\": \"$ACCOUNT\",
    \"region\": \"$REGION\",
    \"time\": \"2026-08-07T00:00:00Z\",
    \"resources\": [],
    \"detail\": {}
  }" \
  --region "$REGION"
# { "Result": true }
```

Re-run it with `"aws.health*"` in the pattern and you get `false` — that is the
wildcard failure from §2, made visible in one command.

**b. The endpoint accepts your token.** Post a deliberately non-Health payload.
It proves reachability, TLS, and the credential, and it writes **nothing** to the
timeline because the parser rejects it:

```bash
curl -sS -X POST "$HUB/api/infra/health/ingest" \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"source":"agent-hub.connectivity-check","detail-type":"probe","detail":{}}'
```

```json
{ "accepted": 0, "deduped": 0, "rejected": 1, "overflow": 0, "reasons": ["wrong-source"] }
```

A `401` here means the token is wrong or revoked; anything other than a JSON
body means you are not talking to the Hub.

**c. EventBridge actually delivered.** After a real Health event fires, the
AWS Health panel shows it, and the token's **last used** timestamp advances.
Read it back with:

```bash
curl -sS "$HUB/api/projects/$PROJECT/infra/health-ingest" \
  -H "x-api-key: $ADMIN_KEY"
```

`info.lastUsedAt` is set on every successful token resolution — including the
probe in (b) — so it distinguishes "the rule was never wired up" from "the rule
is wired up and no events have happened yet". The events themselves come from
`GET /api/projects/<project-id>/infra/health-events`, whose response also
carries `ingestConfigured` for exactly that distinction.

## 9. Region strategy

AWS Health delivers events **per Region**. One rule covers one Region, so repeat
§4, §5 and §7 in each Region you care about — connections, API destinations and
rules are all Regional. The IAM role from §6 is not: IAM is global, so one role
serves every Region.

Three rules of thumb:

- **Global events only reach `us-east-1`.** Events that are not Region-specific
  — IAM is the canonical example — are delivered only to US East (N. Virginia).
  If you create exactly one rule, make it there.
- **Backup Regions are automatic.** In the standard partition, **US West
  (Oregon) is the backup Region for every other Region, and US East
  (N. Virginia) is the backup for US West (Oregon)**. Health events go to both
  the impacted Region and its backup. Account-specific events are sent to the
  backup Region _regardless of whether you have a rule in the impacted Region_;
  public events are mirrored to the backup when a valid rule exists in the
  impacted Region. Putting a rule in the backup Region is what makes the
  integration survive a Regional problem in the Region you are trying to be
  told about.
- **Duplicates are the expected outcome of doing this correctly.** See §10.

If you deliberately do not want the backup fan-out, filter it out on the backup
Region's rule by adding `"backupEvent": ["false"]` under `detail` to the pattern.
Note the string — Health sends `backupEvent`, `page` and `totalPages` as
strings, not JSON booleans/numbers.

**Simplified alternative:** a single rule in **us-west-2** aggregates
account-specific events from every standard-partition Region. It is the least
setup, but it receives no public events and gives you no high-availability
Region, so it suits action-required alerting only.

> **Public health events might take up to one hour to start sending after you
> create an EventBridge rule.** A freshly created rule that has seen nothing is
> not evidence of a broken rule until that hour has passed.

## 10. Duplicates and dedupe

EventBridge delivery is **at-least-once**, and the backup-Region fan-out in §9
is a deliberate second copy on top of that. Duplicates are normal traffic, not a
symptom.

Agent Hub stores one row per Health **communication** and dedupes on AWS's own
recommended key — `eventArn` plus `communicationId` — widened by two columns the
guidance does not cover:

| Column            | Why it is in the key                                                                                                                                                           |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `eventArn`        | AWS: "deduplicate AWS Health events using `eventARN` and `communicationId` because these values remain consistent for AWS Health messages that are sent to the backup Region." |
| `communicationId` | Successive updates to the same incident share an `eventArn` and carry a new `communicationId`, so history accumulates as rows rather than overwriting.                         |
| `affectedAccount` | An event ARN is not unique to an account, so under organizational view the same ARN legitimately arrives once per member account.                                              |
| `page`            | AWS documents the page number as folded into `communicationId` in one place and shared across pages in another. Including it is correct under either reading.                  |

The ingest response reports what was suppressed:

```json
{ "accepted": 1, "deduped": 1, "rejected": 0, "overflow": 0 }
```

**A steady non-zero `deduped` is a sign of health, not a bug.** It is what a
correctly configured primary + backup Region pair looks like. `deduped` dropping
to zero across the board is more interesting — it usually means the backup rule
stopped firing.

The timeline collapses to the newest communication per
(`eventArn`, `affectedAccount`) on read, so an incident that AWS updates six
times shows as one entry with the latest status, not six.

## 11. Limits

| Limit                            | Value                             | Notes                                                                                                   |
| -------------------------------- | --------------------------------- | ------------------------------------------------------------------------------------------------------- |
| EventBridge message size         | 256 KB                            | Health splits larger events across pages (below)                                                        |
| API destination invocation rate  | 300/sec default                   | Configurable per destination; well above Health volume                                                  |
| API destination response timeout | 5 seconds                         | EventBridge times out slower responses and retries them                                                 |
| EventBridge retry window         | 24 hours / 185 attempts (default) | Retries `401`, `407`, `409`, `429` and `5xx`; does **not** retry other `1xx`/`2xx`/`3xx`/`4xx`          |
| Ingest request body              | 1 MiB                             | `413`, whole request rejected                                                                           |
| Envelopes per ingest request     | 100                               | Extras dropped and counted in `overflow`; an API destination sends one event per request, so normally 1 |
| Per-project ingest rate          | 600 req/min (default)             | `429 project rate limit exceeded`, `Retry-After: 60`                                                    |
| Per-IP pre-auth rate             | 1,200 req/min (default)           | `429 rate limit exceeded`, `Retry-After: 60`                                                            |

Because EventBridge retries `429` and `5xx` within a 24-hour window, hitting a
rate limit or a store outage delays events rather than losing them. The
per-project and per-IP ceilings are set orders of magnitude above real Health
volume — they exist to bound a misconfigured rule or a caller probing tokens.

### Paginated events

When a Health event's `resources` / `detail.affectedEntities` list would push the
message past EventBridge's 256 KB limit, AWS splits it into multiple messages.
Every page carries the **same `eventArn` and `communicationId`**, plus
`detail.page` and `detail.totalPages`. Pages are order-agnostic and identical
apart from the entity list.

Agent Hub keys on the page number, so each page is stored once and the entity
lists reassemble; you do not need a `detail.page` filter on the rule. (That
filter is AWS's advice for rules pointed at _human-readable_ targets like email
or chat, where extra pages are noise.)

## 12. Troubleshooting

| Symptom                                                   | Cause                                                                              | Fix                                                                                                                                                                                                      |
| --------------------------------------------------------- | ---------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Rule exists, `ENABLED`, never fires                       | `source` uses a wildcard (`"aws.health*"`)                                         | Use the exact literal from §2. Confirm with `test-event-pattern` (§8a) — it returns `false`.                                                                                                             |
| Rule exists, never fires, pattern verified                | Wrong Region — global events (IAM) only reach `us-east-1`                          | Add a rule in `us-east-1`, plus your backup Region (§9).                                                                                                                                                 |
| Brand-new rule, nothing yet                               | Public events take up to an hour to start flowing after rule creation              | Wait an hour before debugging further.                                                                                                                                                                   |
| `401 missing ingest token`                                | No `Authorization: Bearer` and no `X-AgentHub-Health-Token` header reached the Hub | Check the connection's `ApiKeyName`; a proxy in front of the Hub may be stripping `Authorization` (§4).                                                                                                  |
| `401 invalid or revoked ingest token`                     | Token rotated or revoked, or the `Bearer ` prefix is missing/duplicated            | Re-mint (§3) and update the connection. Rotation has no grace window — the old token dies instantly.                                                                                                     |
| `429 rate limit exceeded` / `project rate limit exceeded` | Per-IP or per-project ceiling hit                                                  | Usually a fan-in misconfiguration. EventBridge honours `Retry-After` and redelivers, so no events are lost; find what is looping.                                                                        |
| `413 request body exceeds size cap`                       | Body over 1 MiB                                                                    | Only reachable if something coalesces events in front of the endpoint. Send one envelope per request.                                                                                                    |
| `503 infrastructure store is unavailable`                 | The Hub's infra store is not open yet                                              | **Retryable** — EventBridge redelivers for up to 24 hours. Check the Hub is up and the Infrastructure module is initialised.                                                                             |
| `200` with `rejected > 0` and a `reasons` array           | Payload is not a recognisable Health event                                         | `wrong-source` / `wrong-detail-type` mean the rule pattern is too broad; `missing-event-arn` and friends mean an input transformer mangled the envelope. Do not use an input transformer on this target. |
| Events arrive, but late or in bursts                      | The endpoint is slower than the 5-second API destination timeout                   | EventBridge times out at 5s and retries. Check the Hub is not saturated; ingest does one bounded write and should answer in milliseconds.                                                                |
| `FailedEntryCount > 0` from `put-targets`                 | Role missing `events:InvokeApiDestination`, or caller missing `iam:PassRole`       | See §6. Remember the `/*` suffix on the destination ARN.                                                                                                                                                 |
| Duplicate-looking rows in `deduped`                       | Working as intended                                                                | See §10 — the backup-Region copy is deliberate.                                                                                                                                                          |

## Out of scope

- **Agent Hub calling AWS.** This path is push-only. The Hub never calls
  `DescribeEvents`, never creates the rule, and holds no credential in the
  monitored account for Health.
- **Backfill.** Only events delivered after the rule exists appear. There is no
  way to replay Health history through EventBridge, and on a sub-Business
  support plan there is no API to backfill from either.
- **Organizational aggregation.** A rule receives events for its own account.
  To collect events for other accounts in an AWS Organization, use Health
  organizational view and delegated administrator access, then forward from the
  management account.
