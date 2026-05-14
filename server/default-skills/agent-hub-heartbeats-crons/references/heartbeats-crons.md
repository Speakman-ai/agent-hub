# Heartbeats & Crons — Scheduled Agents, Threads, Logs

Two overlapping concepts. Both schedule agent work on a cron expression
and emit into a live thread.

- **Heartbeats** are per-agent scheduled **check-ins** — typically a
  short prompt that asks the agent to report status or pick up a task.
- **Crons** are project-scoped **automated jobs** — longer prompts that
  run as standalone sessions (dependabot merging, job-search monitoring,
  scheduled audits, etc.).

Back to [SKILL.md](../SKILL.md).

**Endpoint contracts:**
<https://speakman-ai.github.io/agent-hub/#tag/Heartbeats> and
<https://speakman-ai.github.io/agent-hub/#tag/Crons> (request/response
shapes for schedule, run, logs, thread). This page is the *how*.

## Heartbeats

```bash
scripts/heartbeats.sh list                          # all agents + state
scripts/heartbeats.sh logs    <agentId>             # per-agent run history
scripts/heartbeats.sh thread  <agentId>             # live WebSocket thread
scripts/heartbeats.sh run     <agentId>             # trigger a run now
scripts/heartbeats.sh update  <agentId> '{
  "prompt": "Summarize open PRs and flag anything stale.",
  "schedule": "0 */6 * * *",
  "enabled": true
}'
```

Heartbeat rows carry `agent_id`, `schedule`, `prompt`, `enabled`,
`last_run_at`, plus runtime state (`running`, `next_run_at`) served by
`/api/heartbeats/state`.

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
scripts/crons.sh thread <cronId>
```

Crons write into their own threads for persistent output logs (see the
wiki page "Threads — Persistent Output Logs for Heartbeats & Crons" for
the full thread contract).

## Scheduling semantics

Both use `node-cron` expressions. Server timezone is UTC unless overridden
in `~/.agent-hub/data/config.json`. Schedules are validated on create; a
bad expression returns `400`.

## Why they emit to threads

Rather than dumping output into an interactive session, scheduled runs pipe their
streamed tokens into a **thread** row so the UI can show a persistent log
per heartbeat / cron without cluttering the session list. The thread is
what `scripts/heartbeats.sh thread` / `scripts/crons.sh thread` attach to.
