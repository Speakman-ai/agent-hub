# Sending application logs to Agent Hub

Route your application (or OpenTelemetry Collector) logs into Agent Hub so you
get a live tail, grouped Issues, and one-click **Analyze** / **Fix** on real
errors. This guide is copy-ready: create a source, grab its token, point an
exporter at the ingest endpoint, done.

Prefer to be walked through it? Open **Settings → Logs** for a project and click
**Set up with AI** — a guided worktree session reads your repo, wires an
exporter into your app on a branch, and opens a PR. The steps below are what
that helper automates.

The full request/response shapes for every endpoint here are in the generated
OpenAPI reference: [`docs/api/openapi.yaml`](../api/openapi.yaml), published at
<https://speakman-ai.github.io/agent-hub/> (tags **Log Sources** and **Logs**).

## 1. Create a log source and copy its token

A **log source** is a named write-only ingest credential scoped to exactly one
`(project, source)`. Create one under **Settings → Logs**, or via the API
(Admin role):

```bash
curl -X POST "$HUB/api/projects/$PROJECT/log-sources" \
  -H "x-api-key: $ADMIN_KEY" \
  -H "Content-Type: application/json" \
  -d '{"name":"api-prod","serviceName":"api","environment":"production"}'
```

The `201` response carries the plaintext token **exactly once**:

```json
{
  "id": "…",
  "name": "api-prod",
  "serviceName": "api",
  "environment": "production",
  "tokenPrefix": "ahlog_1a2b3c4d",
  "status": "active",
  "token": "ahlog_XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX"
}
```

Only `sha256(token)` is stored — the plaintext is never retrievable again. Put
it in your deployment's secret store and reference it as an env var (below we
use `$AHLOG_TOKEN`). If you lose it, **rotate** (§7) rather than recreate the
source, so the source's history and issue grouping stay intact.

### Token facts

- **Write-only.** The token authenticates log ingestion only. It cannot read
  logs, list sources, or call any other Agent Hub API.
- **Identity comes from the token, never the request body.** You cannot spoof
  another project or source by setting fields in the payload — `service` and
  `environment` in a record are facets, not identity.
- **Server/collector credential, not a browser secret.** Never ship an
  `ahlog_` token to a browser (see [Out of scope](#out-of-scope)).
- **TLS required outside loopback.** Send over HTTPS in any real deployment.

## 2. Pick an endpoint

Authenticate every ingest request with the token in **either** header:

```
Authorization: Bearer ahlog_…
X-AgentHub-Log-Token: ahlog_…
```

| Endpoint                 | Body                                                                                  | Use it for                                 |
| ------------------------ | ------------------------------------------------------------------------------------- | ------------------------------------------ |
| `POST /api/otel/v1/logs` | OTLP/HTTP: `application/json` **or** `application/x-protobuf`, each optionally `gzip` | An OpenTelemetry SDK or Collector          |
| `POST /api/logs/ingest`  | Agent Hub JSON batch (`{ records: [...] }`)                                           | A tiny integration with no OTel dependency |

Both map to the same canonical OpenTelemetry LogRecord model and preserve
timestamp, observed timestamp, severity, body, resource, attributes,
instrumentation scope, `trace_id`, and `span_id`.

### Agent Hub JSON batch (`/api/logs/ingest`)

The simplest possible integration — one POST, no SDK:

```bash
curl -X POST "$HUB/api/logs/ingest" \
  -H "Authorization: Bearer $AHLOG_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "resource": { "service.name": "api", "deployment.environment": "production" },
    "records": [
      {
        "timeUnixMillis": 1752460800000,
        "severityText": "ERROR",
        "body": "Unhandled rejection: read ECONNRESET",
        "attributes": { "route": "/checkout", "status": 500 },
        "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
      }
    ]
  }'
```

Response (`200`, even on partial success — a rejected record must never make
your app treat the request as failed):

```json
{ "accepted": 1, "rejected": 0 }
```

Per-record fields (all optional except a body):

| Field                                                      | Notes                                                   |
| ---------------------------------------------------------- | ------------------------------------------------------- |
| `timeUnixNano` / `timeUnixMillis` / `observedTimeUnixNano` | First present wins; falls back to server receive time   |
| `severityNumber` / `severityText` / `severity`             | OTel severity number, or a text label mapped to one     |
| `body` / `message`                                         | The log line. Objects are JSON-stringified              |
| `attributes`                                               | Per-record key/values                                   |
| `resource`                                                 | Merged over the batch-level `resource`                  |
| `scope`                                                    | Instrumentation scope                                   |
| `traceId` / `spanId`                                       | Correlation ids                                         |
| `service` / `environment`                                  | Shorthand for `service.name` / `deployment.environment` |

### OTLP/HTTP (`/api/otel/v1/logs`)

Point any OTLP/HTTP log exporter here. It accepts the standard
`{ resourceLogs: [...] }` envelope as JSON or binary Protobuf, gzip optional,
and replies with an `ExportLogsServiceResponse` in the same wire format
(`partialSuccess.rejectedLogRecords` set when some records were dropped).

```bash
curl -X POST "$HUB/api/otel/v1/logs" \
  -H "Authorization: Bearer $AHLOG_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "resourceLogs": [{
      "resource": { "attributes": [
        { "key": "service.name", "value": { "stringValue": "api" } }
      ]},
      "scopeLogs": [{
        "logRecords": [{
          "timeUnixNano": "1752460800000000000",
          "severityNumber": 17,
          "severityText": "ERROR",
          "body": { "stringValue": "Unhandled rejection: read ECONNRESET" }
        }]
      }]
    }]
  }'
```

## 3. Node application example

Two options. Use the OTel SDK if you already have it; otherwise a ~20-line
batching wrapper over `/api/logs/ingest` is plenty.

### Option A — OpenTelemetry SDK

```bash
npm i @opentelemetry/sdk-logs @opentelemetry/exporter-logs-otlp-http \
      @opentelemetry/api-logs @opentelemetry/resources \
      @opentelemetry/semantic-conventions
```

```js
import { LoggerProvider, BatchLogRecordProcessor } from '@opentelemetry/sdk-logs';
import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { ATTR_SERVICE_NAME } from '@opentelemetry/semantic-conventions';

const exporter = new OTLPLogExporter({
  url: `${process.env.HUB_URL}/api/otel/v1/logs`,
  headers: { Authorization: `Bearer ${process.env.AHLOG_TOKEN}` },
});

const provider = new LoggerProvider({
  resource: resourceFromAttributes({
    [ATTR_SERVICE_NAME]: 'api',
    // `deployment.environment.name` is an incubating convention; its exported
    // constant `ATTR_DEPLOYMENT_ENVIRONMENT_NAME` lives in
    // `@opentelemetry/semantic-conventions/incubating`. The plain string key
    // is stable across versions, so we use it directly here.
    'deployment.environment.name': 'production',
  }),
  processors: [new BatchLogRecordProcessor(exporter)],
});

const logger = provider.getLogger('api');
logger.emit({ severityText: 'ERROR', body: 'Unhandled rejection: read ECONNRESET' });
```

> Uses the current OpenTelemetry JS API: `resourceFromAttributes()` (not the
> deprecated `new Resource()`), the `processors` constructor option (not
> `addLogRecordProcessor()`), and the `ATTR_SERVICE_NAME` constant export (not
> the removed `SemanticResourceAttributes`).

`BatchLogRecordProcessor` batches and retries for you; keep batches under the
[limits](#4-limits-batching-and-expected-data-loss).

### Option B — dependency-free JSON batch

```js
const HUB = process.env.HUB_URL;
const TOKEN = process.env.AHLOG_TOKEN;
let buffer = [];

export function logToHub(severityText, body, attributes = {}) {
  buffer.push({ timeUnixMillis: Date.now(), severityText, body, attributes });
  if (buffer.length >= 100) void flush();
}

async function flush() {
  if (buffer.length === 0) return;
  const records = buffer.splice(0, 1000); // stay under the 1,000/batch cap
  try {
    const res = await fetch(`${HUB}/api/logs/ingest`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        resource: { 'service.name': 'api', 'deployment.environment': 'production' },
        records,
      }),
    });
    // 429/503 = backpressure: requeue and retry with backoff. Never throw into
    // the request path — logging must not break the app.
    if (res.status === 429 || res.status === 503) buffer.unshift(...records);
  } catch {
    buffer.unshift(...records);
  }
}

setInterval(() => void flush(), 2000).unref(); // periodic flush
```

### Avoid the exporter feedback loop

If your exporter POSTs to the Hub over an HTTP client that *itself* logs
requests, and those logs propagate to the same root logger you export from, you
get a self-sustaining loop: the exporter sends a batch → the HTTP client logs
that `POST /api/logs/ingest` → the root logger exports that record → the
exporter sends it → repeat. The tell is a steady stream of `200 OK`
`.../api/logs/ingest` INFO lines from a transport logger (`httpx`/`httpcore` in
Python, `undici`/`http` in Node) that carry no application meaning.

The Hub cannot break this loop for you — a record describing a call to
`/api/logs/ingest` is indistinguishable from a legitimate "my service called an
ingest endpoint" log, so the ingest endpoint accepts both. Fix it at the source,
in your logging config, by keeping the exporter's own transport off the exported
pipeline. Either raise the transport logger's level so its request lines never
fire:

```python
# Python: silence the HTTP client the Hub exporter rides on
logging.getLogger("httpx").setLevel(logging.WARNING)
logging.getLogger("httpcore").setLevel(logging.WARNING)
```

or attach a handler-level filter, keyed to the Hub ingest URL, that drops only
records whose message references your ingest endpoint — precise enough to keep
other HTTP logs flowing. Whichever you pick, verify with a quick smoke test that
a single emitted log produces exactly one ingest POST, not a cascade.

## 4. OpenTelemetry Collector example

The Collector is the recommended buffer for production: it handles retry,
batching, compression, and lets you filter/sample before export. Point an
`otlphttp` exporter at the Hub:

```yaml
receivers:
  otlp:
    protocols:
      http:
      grpc:

processors:
  batch:
    send_batch_size: 512 # keep exported batches under the 1,000-record cap
    send_batch_max_size: 1000

exporters:
  otlphttp/agenthub:
    logs_endpoint: https://your-hub.example.com/api/otel/v1/logs
    headers:
      Authorization: 'Bearer ${AHLOG_TOKEN}'
    compression: gzip
    sending_queue:
      enabled: true
    retry_on_failure:
      enabled: true

service:
  pipelines:
    logs:
      receivers: [otlp]
      processors: [batch]
      exporters: [otlphttp/agenthub]
```

Your services speak OTLP to the Collector (gRPC or HTTP); the Collector speaks
OTLP/HTTP to the Hub. Note the Hub itself does **not** accept OTLP/gRPC — the
Collector bridges gRPC ingest to the Hub's HTTP endpoint.

## 5. Limits, batching, and expected data loss

Ingest is fire-and-forget through a bounded in-process write queue: a POST
returns as soon as records are accepted into the queue, never blocked on disk.
Records can be dropped — design your exporter to tolerate it and never let
logging failures block or crash your app.

| Limit                       | Value                   | On breach                                  |
| --------------------------- | ----------------------- | ------------------------------------------ |
| Request / decompressed body | 1 MiB                   | `413`, whole request rejected              |
| Records per batch           | 1,000                   | Overflow dropped, counted in `rejected`    |
| Single normalized record    | 256 KiB                 | That record dropped, counted in `rejected` |
| Per-source rate             | 3,000 rec/min (default) | `429 source rate limit exceeded`           |
| Per-IP pre-auth rate        | 6,000 rec/min (default) | `429 rate limit exceeded`                  |
| Write queue saturated       | backpressure            | `429 log write queue saturated`            |
| Store unavailable           | —                       | `503 log store temporarily unavailable`    |

Handle `429` and `503` by retrying with exponential backoff (the Collector's
`retry_on_failure` and `sending_queue` do this automatically). A `2xx` with a
non-zero `rejected` count means some records were dropped for size/overflow —
the request still succeeded. Auth failures return `401`; malformed bodies
`400`.

### Retention and quota defaults

| Setting           | Default | Operator range  |
| ----------------- | ------- | --------------- |
| Retention         | 7 days  | 1–90 days       |
| Per-project quota | 5 GiB   | 64 MiB – 64 GiB |

Both are operator-configurable within those bounds. When a project is over
quota or past retention, the reaper deletes the **oldest** records first. Sizing
your volume above the quota means the tail is your effective retention window —
send sampled/filtered developer-relevant logs, not everything (see
[Out of scope](#out-of-scope)).

## 6. Redaction (what gets stripped before storage)

Every ingested field is treated as untrusted. Before anything is persisted the
Hub normalizes control characters, renders values as text only (log content can
never act as agent instructions), and applies **key-based plus configurable
regex redaction**. Built-in patterns cover authorization headers, bearer/API
tokens, passwords, connection strings, private keys, and common credential
formats. Redacted values are replaced in place; the redaction count is exported
as a health metric. You can add project-level regex patterns for your own
secret shapes. Redaction happens **before** persistence, so raw secrets never
touch `logs.db`.

## 7. Rotating and revoking a token

Rotate on a schedule or after any suspected leak. Rotation mints a fresh
plaintext token (returned once) and invalidates the old one:

```bash
curl -X POST "$HUB/api/projects/$PROJECT/log-sources/$SOURCE/rotate" \
  -H "x-api-key: $ADMIN_KEY"
```

Deploy the new token, confirm ingest resumes, then the old token is already
dead. To retire a source entirely, **revoke** it (keeps history, stops ingest)
or **delete** it. Every create/rotate/revoke/delete is recorded in the source's
audit log (`GET /api/projects/$PROJECT/log-sources/$SOURCE/audit`).

## 8. Analyze and Fix

Once errors land, the **Issues** view groups repeated `ERROR`-or-higher records
into issue groups (fingerprinted by service, environment, exception type,
normalized message, and top in-app stack frames — never by timestamp, request
id, or release). Each group has two buttons:

- **Analyze** starts a normal chat session on the project's default dev agent,
  in an isolated worktree, with `finalize_automation = manual`. Its first prompt
  is a **read-only** root-cause brief: investigate, give evidence and
  confidence, make no edits, create no cards, and end by asking for next steps.
  The session is linked to the issue group and stays ordinary chat afterward, so
  you can ask it to go fix the thing without losing context.
- **Fix** creates or reuses one active kanban card for the issue, spins up a
  worktree chat session, links both to the issue, and moves the card to In
  Progress. It seeds the agent with the grouped error context, relevant
  releases/trace ids, acceptance criteria, and a regression-test requirement.

Only a bounded, redacted excerpt (≤ 32 KiB, ≤ 50 representative records, inside
explicit untrusted-data fences) is ever placed in an agent prompt. The Hub
records who launched each action and which records were included.

### Finalize-default inheritance

A **Fix** session inherits the initiating user's project
`defaultFinalizeAutomation`. When that is unset it falls back to **Build /
manual** — it deliberately does **not** use the board-assignment helper that
forces Push or Auto Merge, so an AI fix for a log error never auto-ships. You
choose whether it pushes or merges, per your project's Finalize automation
level.

## Out of scope

This module is a self-hosted developer log tail and AI triage surface, not a
Datadog/Loki replacement. Explicitly **not** in scope:

- **Browser-direct ingestion.** `ahlog_` tokens are server/collector
  credentials. Browser errors go through the existing RUM/replay path or a
  trusted collector, never direct browser → ingest.
- **Automatic remediation.** Analyze and Fix are manual buttons only. Log
  arrival, severity, or issue count never auto-creates cards, starts sessions,
  pushes code, or merges.
- **Metrics and traces.** Logs only. No metrics or traces ingestion.
- **OTLP/gRPC.** OTLP/HTTP (JSON or Protobuf) only. Bridge gRPC through a
  Collector.
- **High-volume / multi-node storage.** The dedicated SQLite store targets a
  single Hub instance and moderate volumes. For sustained high volume or
  multi-node deployments, send OTLP through a Collector to a dedicated backend
  and forward only sampled/filtered developer-relevant logs to the Hub.
