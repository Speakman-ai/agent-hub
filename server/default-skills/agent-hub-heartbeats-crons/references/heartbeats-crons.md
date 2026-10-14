# Crons — Scheduled Jobs and Run Logs

**Crons** are project-scoped automated jobs. They schedule agent work on a
cron expression and record each run in the cron run log.

Per-agent **heartbeats** are retired. `scripts/heartbeats.sh` exits with
an error. Use a project cron instead of a per-agent check-in.

Back to [SKILL.md](../SKILL.md).

**Endpoint contract:**
<https://speakman-ai.github.io/agent-hub/#tag/Crons> (request/response
shapes for schedule, run, logs). This page is the _how_.

## Crons

```bash
scripts/crons.sh list
scripts/crons.sh create '{
  "name": "Nightly deps audit",
  "schedule": "0 3 * * *",
  "prompt": "Run `npm outdated` and open a PR for non-major bumps.",
  "agentId": "<agent-id>",
  "enabled": true
}'
scripts/crons.sh update <cronId> '{"enabled":false}'
scripts/crons.sh delete <cronId>
scripts/crons.sh run    <cronId>
scripts/crons.sh logs   <cronId>
```

## Scheduling semantics

`node-cron` expressions. Server timezone is UTC unless overridden
in `~/.agent-hub/data/config.json`. Schedules are validated on create; a
bad expression returns `400`.

## Run logs

Each run writes one `cron_logs` row (the last 100 per cron are kept):

- **success**: the engine output.
- **error**: `ERROR: <message>` followed by `--- stdout ---` and
  `--- stderr ---` sections when the engine printed anything before failing
  (for example a timeout partway through).

`scripts/crons.sh logs <cronId>` returns them newest first. In the UI,
Settings → Cron jobs → **View log** opens the newest run, and the run chips
open older ones.

## Notifications

Crons send no push notifications of their own. Add a **Cron finished**
trigger in Project Settings → Chat triggers to post finished runs into a
chat channel (filter by outcome to hear only about errors). A trigger can
also post to a Google Chat space. Members of that channel get the usual
chat notifications.
