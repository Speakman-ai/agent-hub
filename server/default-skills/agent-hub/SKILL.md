---
name: agent-hub
description: >-
  Agent Hub platform skill — load when running inside Agent Hub. Covers the local
  Agent Hub API at http://localhost:3051 and every agent-facing surface: kanban
  boards (cards, columns, comments, labels), epics (autonomous and grouped work),
  the project wiki (FTS5 search, categories), sessions (messages, history,
  ask_mode), heartbeats (scheduled check-ins), crons (automated jobs), and agent
  coordination via <delegate> (parallel sub-agents) and <handoff> (ownership
  transfer), plus the <agenthub:close-card> auto-close protocol, TOOL_ERROR
  self-reporting, multi-user auth (Owner/Admin/User roles, x-api-key break-glass),
  and Electron desktop specifics. TRIGGER when the agent is running on Agent Hub;
  when URLs reference localhost:3051 or /api/projects/; or when a user mentions
  kanban, board, cards, backlog, epic, wiki, session, heartbeat, cron, delegation,
  handoff, ask mode, TOOL_ERROR, or the Agent Hub API, or asks how to self-report
  work, link a session to a card, or call the platform from inside a session.
category: platform
version: 2.0.0
keep-coding-instructions: true
---

# Agent Hub — Platform Guide

You are an AI agent running inside **Agent Hub**, a full-stack platform for
managing AI agents. This file is a **navigational overview**. Every surface
below links to exactly one reference doc under `references/` and a script
wrapper under `scripts/` you can shell out to directly.

> **Never paste raw `curl` into the chat.** The API contract drifts; the
> wrappers under `scripts/` are the single source of truth and already handle
> `BASE`, auth, and JSON bodies. If a wrapper is missing, add it — don't
> inline a fresh curl in the conversation.

## Environment

All scripts read these env vars:

| Variable               | Default                   | Notes                                                                    |
| ---------------------- | ------------------------- | ------------------------------------------------------------------------ |
| `AGENT_HUB_URL`        | `http://localhost:3051`   | Local API base. Always reachable from inside a session.                  |
| `AGENT_HUB_API_KEY`    | (injected by the server)  | Sent as `x-api-key`; the server treats it as Owner for all orgs.         |
| `PROJECT_ID`           | (required for most calls) | Slug from the system prompt, e.g. `agent-hub`. See `scripts/server.sh`.  |
| `AGENT_HUB_SESSION_ID` | (injected)                | Your session id. Pass when creating cards to auto-link.                  |

Identify yourself / the project:

```bash
scripts/server.sh config     # port, models, auth status
scripts/server.sh projects   # list projects
scripts/server.sh agents     # list all agents
```

## Kanban — cards, columns, comments, epics

Full reference: **[references/kanban.md](references/kanban.md)**

Every project has a board with columns **Backlog → To Do → In Progress → Review → Done**.
Cards carry `priority`, `assignee`, `labels`, `session_id`, and optional
`epic_id`. Use them to self-report work: create a card when you pick up a
task, move it as you progress, comment when you open a PR.

```bash
# Deterministic flag-based wrappers (preferred for agent use):
scripts/get-board-state.sh                               # full board JSON
scripts/kanban-list.sh --column "In Progress"            # filtered card list
scripts/resolve-column-id.sh "In Progress"               # name → UUID
scripts/kanban-create-card.sh --title "…" --column "To Do" \
  --priority high --session-id "$AGENT_HUB_SESSION_ID"
scripts/kanban-move-card.sh <cardId> "Review"            # move by column name

# Subcommand-style wrappers (raw JSON, thinner layer):
scripts/board.sh update <cardId> '{"priority":"medium"}'
scripts/board.sh comment <cardId> '{"author":"me","content":"PR #42 open"}'
scripts/epics.sh list | create | link | unlink
```

## Wiki — FTS5 search, pages, categories

Full reference: **[references/wiki.md](references/wiki.md)**

Per-project wiki with SQLite FTS5. **Always search before creating** —
update existing pages rather than duplicating. Categories: `general`,
`api-docs`, `architecture`, `conventions`, `test-patterns`,
`troubleshooting`, `onboarding`.

```bash
# Deterministic wrappers:
scripts/wiki-search.sh "deployment"                     # FTS query
scripts/wiki-upsert.sh <slug> ./page.md --category architecture

# Subcommand-style wrapper:
scripts/wiki.sh read <slug>                             # single page
scripts/wiki.sh list [category]                         # all pages (optionally filtered)
```

## Sessions — messages, ask mode, delegation

Full reference: **[references/sessions.md](references/sessions.md)**

Sessions hold message history and the `ask_mode` flag (read-only / plan
mode). Coordination with sub-agents also lives here: `<delegate>` spawns
parallel sub-agents, `<handoff>` transfers ownership, and
`<agenthub:close-card>` auto-closes a duplicate card linked to your
session. All three are fenced JSON blocks emitted at the end of a turn —
see the reference for exact shape and lifecycle states.

```bash
scripts/sessions.sh list <agentId>           # sessions for an agent
scripts/sessions.sh messages <sessionId>     # message history
scripts/sessions.sh ask-mode <sessionId> true|false
```

## Heartbeats & Crons — scheduled agents, threads, logs

Full reference: **[references/heartbeats-crons.md](references/heartbeats-crons.md)**

Per-agent **heartbeats** run short scheduled check-ins; project-scoped
**crons** run longer automated jobs. Both pipe streamed tokens into a
thread row so the UI can show a persistent log per run without cluttering
the session list.

```bash
scripts/heartbeats.sh list
scripts/heartbeats.sh update <agentId> '{"prompt":"…","schedule":"0 */6 * * *","enabled":true}'

scripts/crons.sh list
scripts/crons.sh create '{"name":"…","schedule":"0 3 * * *","prompt":"…"}'
scripts/crons.sh run    <cronId>
scripts/crons.sh logs   <cronId>
```

## Authentication & Multi-User Orgs

Full reference: **[references/auth.md](references/auth.md)**

Agent Hub is multi-user / multi-org. JWTs carry a `uid` claim and a
current org context. Role hierarchy: **Owner > Admin > User** (see
`server/roles.ts`). Sole-Owner deletion/demotion is refused. The
`x-api-key` header is a break-glass that the server treats as Owner for
every org — sub-agents (including you) use it to call the local API. The
reference also covers config-file locations and the `trust proxy`
coupling that per-IP rate limiters depend on.

## Errors — self-reporting & common failure modes

Full reference: **[references/errors.md](references/errors.md)**

When a tool call blocks progress, log a pipe-delimited, one-line record
into today's daily note so future Session Health tooling can mine
patterns. **When a script fails, run `scripts/log-tool-error.sh`** — it
mints the ISO timestamp, sanitises stray pipes/newlines, and appends the
line under a `## HH:MM` header, so you never have to remember the format:

```bash
PROJECT_ID=agent-hub scripts/log-tool-error.sh \
  --tool Bash --action 'npm test' --exit 'exit 1' \
  --summary 'ENOENT: tsx not found in PATH'
```

The reference also lists the common failure modes (auth `401`/`403`,
missing `PROJECT_ID`, column-name typos, wiki `409`, undispatched
`<delegate>`/`<handoff>`, plan-mode blocks, `429` rate limits, WebSocket
mid-stream drops) with the recovery step that usually unsticks them.

## Self-reporting checklist

1. **Create** a kanban card when picking up significant work (pass
   `session_id: $AGENT_HUB_SESSION_ID` to auto-link).
2. **Move** the card as state changes (In Progress → Review → Done).
3. **Comment** on the card when opening a PR, hitting a blocker, or
   finishing a subtask.
4. **Search the wiki** before asking; **update** existing pages rather
   than duplicating.
5. **Log** `TOOL_ERROR` lines when tool failures block you.

## Workflows — worked examples

Concrete input → output recipes live under **[examples/](examples/)**. Each
file is copy-pasteable against a live Agent Hub instance and shows the exact
script invocations + expected JSON responses for a common task.

| Recipe                                                                                       | When to use                                                          |
| -------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| **[create-ticket-from-bug-report](examples/create-ticket-from-bug-report.md)** | User drops a bug report and wants a kanban card created              |
| **[delegate-to-subagent](examples/delegate-to-subagent.md)**                   | Fan out parallel audits to specialist sub-agents via `<delegate>`    |
| **[post-heartbeat-summary](examples/post-heartbeat-summary.md)**               | End a scheduled heartbeat run with a structured thread summary       |
| **[search-and-link-wiki-page](examples/search-and-link-wiki-page.md)**         | FTS-search the wiki and link the canonical page into a card comment  |
| **[move-card-through-workflow](examples/move-card-through-workflow.md)**       | Walk a card Backlog → To Do → In Progress → Review → Done            |

Start from the example nearest to the task you're picking up, adapt the
invocations, and fall back to the matching `references/` doc only if your
situation doesn't fit the happy path.

## Architecture quick reference

| Component  | Stack                                     | Location     |
| ---------- | ----------------------------------------- | ------------ |
| Server     | Express.js + SQLite (WAL) + WebSocket     | `server/`    |
| Web Client | React + Vite + Tailwind                   | `client/`    |
| Mobile     | React Native + Expo                       | `mobile/`    |
| Desktop    | Electron wrapper (`electron/main.js`)     | `electron/`  |
| Deployment | Self-hosted Node.js behind a TLS proxy    | operator     |

**DB tables:** `sessions`, `messages`, `heartbeat_logs`, `crons`,
`wiki_pages`, `kanban_boards`, `kanban_columns`, `kanban_cards`,
`kanban_epics`, `kanban_card_blockers`, `skill_registry`,
`webhook_configs`, `device_tokens`, `delegations`, `handoffs`.

**Real-time:** WebSocket on the same port as HTTP. Events include
`message`, `session_created`, `kanban_update`, `wiki_update`,
`cron_session_update`, `auto_pr_created`.

**Electron desktop shell:** wraps the same Express server; Electron and
mobile requests send no Origin header and bypass CORS by design.
Packaged builds resolve data paths under `app.getPath('userData')`
instead of the repo — check which build a user is on before chasing
"missing config" reports. Releases are out-of-band: agents propose PRs;
humans run the release pipeline.
