---
name: logs-setup
description: >-
  Guided walkthrough for wiring a project's application logs into Agent Hub.
  Triggered by POST .../logs/setup-wizard. Reads the server-precomputed repo
  scan (stack, logging libraries, existing OpenTelemetry setup, exporter target
  candidates, recommended approach, existing log sources), creates a write-only
  ahlog_ log source via the Hub API, wires an OTLP/HTTP or JSON-batch exporter
  into the app referencing the token as an env var (never inlined), verifies it,
  and commits on the session branch for Finalize Code Changes to push.
version: 1.0.0
keep-coding-instructions: true
---

# Logs Setup — wire application logs into Agent Hub

You are a **worktree-backed** setup session: you already sit on a fresh
`agent-hub/…` branch. Instrument the target app to ship its logs to Agent Hub,
commit, and let Finalize Code Changes push and open the PR. **Do not** create a
new branch, and **do not** create or move any kanban card.

## Bound values

- **`PROJECT_ID`**, **`PROJECT_CWD`** — from kickoff. `PROJECT_CWD` is where the
  draft was scanned; your working directory is this session's worktree clone.
- **`YOUR SESSION_ID`** — from kickoff. This session owns the worktree the edits
  commit to. Never ask the user for a `session_id` or tell them to start a
  different session — *this* one is the working session.
- **`$AGENT_HUB_URL`**, **`$AGENT_HUB_API_KEY`** — set for Hub API calls (source
  creation). If a call returns HTTP **401** or **403**, halt and report the auth
  failure. **Never** ask the operator to paste a token into chat.

## Draft (start here)

Kickoff embeds the full `draft` JSON. **Do not re-run scanners** unless the user
changed files mid-session.

| Field | Use |
|-------|-----|
| `stack` | `node` \| `python` \| `go` \| `ruby` \| `java` \| `mixed` \| `unknown` — drives which recipe applies |
| `recommendedApproach` | `collector` \| `otel-sdk` \| `json-batch` — the default path (Step 3) |
| `entryCandidates[]` | Ranked files to wire the exporter into (`path` + `kind`) |
| `loggingLibraries[]` | Logging libs already in the app (winston, pino, structlog, …) |
| `hasOtelSdk` | An OpenTelemetry SDK dependency is already present |
| `hasOtelCollectorConfig` / `collectorConfigPaths` | A Collector config is in the repo — extend it instead of instrumenting the app directly |
| `otlpEndpoint` / `batchEndpoint` | Absolute Hub ingest URLs to POST to |
| `suggestedServiceName` | Best guess at the `service.name` facet |
| `existingSources[]` | Active/revoked log sources already on the project (metadata only, never a token) |
| `envExampleKeys[]` | Env keys the app already reads — place the ingest token alongside them |
| `notes[]` | Ambiguities the scan flagged — resolve with the user before editing |

## Step 1 — Confirm the plan

Summarize the detected stack, `recommendedApproach`, and target file in 2-3
sentences. If `entryCandidates` is empty, `stack` is `unknown`/`mixed`, or
`notes` flags ambiguity, use a fenced `agenthub:ask` (offer `entryCandidates` or
detected services as options) before touching code.

## Step 2 — Get an ingest token

Log sources are **write-only** `ahlog_` credentials scoped to one
`(project, source)`. The plaintext is revealed **once**.

- If `existingSources` has an active source, ask the user whether to reuse it
  (they hold the token) or mint a new one — don't assume.
- To create one:

  ```bash
  curl -X POST "$AGENT_HUB_URL/api/projects/$PROJECT_ID/log-sources" \
    -H "X-API-Key: $AGENT_HUB_API_KEY" \
    -H "Content-Type: application/json" \
    -d '{"name":"<service>","serviceName":"<suggestedServiceName>","environment":"production"}'
  ```

  The `201` response's `token` field is the plaintext `ahlog_…` — surface it to
  the user once and tell them to store it as a deployment secret. **Never**
  hardcode it in source, a committed `.env`, or the PR. Wire the app to read it
  from an env var (e.g. `AHLOG_TOKEN`).

## Step 3 — Instrument by approach

Read the token from the env var in every recipe. Send `Authorization: Bearer
$AHLOG_TOKEN` (or `X-AgentHub-Log-Token`). Stay under the limits: request/body
≤ 1 MiB, ≤ 1,000 records/batch, ≤ 256 KiB/record. Handle `429`/`503` with
backoff; never let a logging failure block or crash the app.

### `collector` (a Collector config already exists)

Add an `otlphttp` exporter pointed at `otlpEndpoint` and wire it into the `logs`
pipeline. Don't instrument the app directly — the Collector is already the
egress point.

```yaml
exporters:
  otlphttp/agenthub:
    logs_endpoint: <otlpEndpoint>
    headers:
      Authorization: "Bearer ${AHLOG_TOKEN}"
    compression: gzip
    retry_on_failure: { enabled: true }
    sending_queue: { enabled: true }
service:
  pipelines:
    logs:
      exporters: [otlphttp/agenthub]   # merge with existing exporters
```

### `otel-sdk` (an OTel SDK is already installed)

Add an OTLP **log** exporter + `BatchLogRecordProcessor` in the app's telemetry
bootstrap (`entryCandidates` with `kind: bootstrap`/`entrypoint`), pointed at
`otlpEndpoint` with the `Authorization` header. Reuse the existing `Resource`
(`service.name`, `deployment.environment`).

### `json-batch` (no OTel — lightest touch, Node)

Add a small buffered POST to `batchEndpoint` in the logger config or entrypoint.
Batch up to ~100 records or ~2s, splice at 1,000, and requeue on `429`/`503`.
See the "dependency-free JSON batch" recipe in the repo guide
`docs/guides/application-logs.md`. For non-Node stacks with no OTel, prefer
routing through a Collector instead.

## Step 4 — Verify and commit

- Type-check / build the target if a script exists (`npm run typecheck`, etc.).
- If feasible, send one test record and confirm a `2xx` with `rejected: 0`.
- Commit your edits on **this** session branch with a clear message. Then end
  your turn. Finalize Code Changes handles review, push, and the PR. Do **not**
  push, open a PR, or move a kanban card yourself.

## Auth failure

If any Hub API call returns **401**/**403**, stop and report it plainly. Do not
retry in a loop and do not ask the user to paste a token into chat — the wizard
already has `$AGENT_HUB_API_KEY`.

## Out of scope (tell the user if they ask)

Browser-direct ingestion (use the RUM path or a trusted collector), automatic
remediation, metrics, traces, OTLP/gRPC, and high-volume multi-node storage are
out of scope. For sustained high volume, forward sampled/filtered logs through a
Collector to a dedicated backend.
