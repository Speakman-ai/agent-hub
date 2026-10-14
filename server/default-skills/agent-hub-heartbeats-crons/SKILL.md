---
name: agent-hub-heartbeats-crons
description: >-
  Agent Hub scheduled work — project-scoped crons (automated jobs).
  Crons run on node-cron expressions and keep each run's output in the
  cron run log. Per-agent heartbeats are retired; use a cron.
  TRIGGER only on Agent Hub scheduling signals: the words "heartbeat",
  "cron", "scheduled agent", "scheduled job", "cron log"; cron-expression
  formats in an Agent Hub context (e.g. "0 */6 * * *" near agentId);
  the wrappers scripts/heartbeats.sh, scripts/crons.sh; or URLs under
  /api/crons. DO NOT TRIGGER on system crontab,
  Kubernetes CronJobs, GitHub Actions cron schedules, AWS EventBridge
  rules, Jenkins triggers, or generic "schedule" / "timer" questions
  without an Agent Hub cron in view.
category: platform
version: 1.0.0
keep-coding-instructions: true
---

# Agent Hub — Crons

**Crons** are project-scoped automated jobs scheduled on `node-cron` —
longer prompts that run as standalone sessions (dependabot merging,
job-search monitoring, scheduled audits, etc.).

Per-agent **heartbeats** are retired. Do not configure or run them. If a
task used to be a heartbeat, create a project cron instead.

Full reference: **[references/heartbeats-crons.md](references/heartbeats-crons.md)**.
Scripts live in the shared core tree (`agent-hub/scripts/`).

```bash
scripts/crons.sh list
scripts/crons.sh create '{"name":"…","schedule":"0 3 * * *","prompt":"…"}'
scripts/crons.sh run    <cronId>
scripts/crons.sh logs   <cronId>
```

## Run logs and notifications

Every run writes a `cron_logs` row: the output on success, and the error
plus stdout/stderr on failure. `crons.sh logs` reads them (newest first);
Settings → Cron jobs shows the same log under **View log**.

Crons do not send push notifications themselves. To hear about finished
runs, add a **Cron finished** chat trigger (Project Settings → Chat
triggers, optionally filtered to success or error). It posts a card into
a chat channel, and optionally a Google Chat space.

## Scheduling semantics

`node-cron` expressions. Server timezone is UTC unless overridden in
`~/.agent-hub/data/config.json`. Schedules are validated on create; a bad
expression returns `400`.

## See also

- Core skill `agent-hub` — env contract, auth, error self-reporting.
- `references/heartbeats-crons.md` — full reference.
