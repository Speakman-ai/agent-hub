---
name: agent-hub-heartbeats-crons
description: >-
  Agent Hub scheduled work — per-agent heartbeats (short scheduled
  check-ins) and project-scoped crons (longer automated jobs). Both run on
  node-cron expressions and pipe streamed tokens into a persistent thread
  row. TRIGGER only on Agent Hub scheduling signals: the words "heartbeat",
  "cron", "scheduled agent", "scheduled job", "thread log"; cron-expression
  formats in an Agent Hub context (e.g. "0 */6 * * *" near agentId);
  the wrappers scripts/heartbeats.sh, scripts/crons.sh; or URLs under
  /api/heartbeats or /api/crons. DO NOT TRIGGER on system crontab,
  Kubernetes CronJobs, GitHub Actions cron schedules, AWS EventBridge
  rules, Jenkins triggers, or generic "schedule" / "timer" questions
  without an Agent Hub heartbeat / cron in view.
category: platform
version: 1.0.0
keep-coding-instructions: true
---

# Agent Hub — Heartbeats & Crons

Two overlapping concepts, both scheduled on `node-cron`:

- **Heartbeats** are per-agent **check-ins** — short prompts that run on a
  schedule and ask the agent to report status or pick up a task.
- **Crons** are project-scoped **automated jobs** — longer prompts that run
  as standalone sessions (dependabot merging, job-search monitoring,
  scheduled audits, etc.).

Full reference: **[references/heartbeats-crons.md](references/heartbeats-crons.md)**.
Scripts live in the shared core tree (`agent-hub/scripts/`).

```bash
scripts/heartbeats.sh list
scripts/heartbeats.sh logs    <agentId>
scripts/heartbeats.sh thread  <agentId>
scripts/heartbeats.sh run     <agentId>
scripts/heartbeats.sh update  <agentId> '{
  "prompt": "Summarize open PRs and flag anything stale.",
  "schedule": "0 */6 * * *",
  "enabled": true
}'

scripts/crons.sh list
scripts/crons.sh create '{"name":"…","schedule":"0 3 * * *","prompt":"…"}'
scripts/crons.sh run    <cronId>
scripts/crons.sh logs   <cronId>
scripts/crons.sh thread <cronId>
```

## Threads

Scheduled runs don't dump output into an interactive session — they pipe
streamed tokens into a **thread** row so the UI can show a persistent log
per run without cluttering the session list. The `thread` subcommand
attaches to it.

## Scheduling semantics

`node-cron` expressions. Server timezone is UTC unless overridden in
`~/.agent-hub/data/config.json`. Schedules are validated on create; a bad
expression returns `400`.

## See also

- Core skill `agent-hub` — env contract, auth, error self-reporting.
- `references/heartbeats-crons.md` — full reference.
