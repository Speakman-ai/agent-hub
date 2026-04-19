---
name: agent-hub
description: >-
  Core knowledge about Agent Hub — the platform you're running on. Covers API access, kanban boards, wiki, sessions, heartbeats, and how to interact with the system.
  TRIGGER when: running inside Agent Hub, or user mentions kanban, wiki, sessions, heartbeats, agent hub API.
category: platform
version: 1.0.0
keep-coding-instructions: true
---

# Agent Hub — Platform Guide

You are an AI agent running inside **Agent Hub**, a full-stack application for managing and interfacing with AI agents. This skill teaches you how to interact with the platform.

## Connecting to the API

Agent Hub exposes a REST API on the server that spawned you. Use `localhost` and the configured port (default `3051`):

```bash
# Base URL (local server — always available from your process)
BASE="http://localhost:3051"
```

If the server requires authentication (remote/EC2 deployments), include the API key header:

```bash
# Authenticated request
curl -s -H "x-api-key: $API_KEY" "$BASE/api/sessions"
```

> **Tip:** For local development (Electron app), auth is usually off. For remote servers, auth is required. If you get a `401`, you need the API key.

Your **project ID** is injected into your system prompt (look for references to `/api/projects/<id>/...` in your instructions). If you're unsure, list all projects:

```bash
curl -s "$BASE/api/projects" | jq '.[].id'
```

## Kanban Board

Every project has a kanban board for task tracking. Default columns: **Backlog, To Do, In Progress, Review, Done**.

### Read the board

```bash
# Get board with all columns and their IDs
curl -s "$BASE/api/projects/$PROJECT_ID/board" | jq

# List all cards
curl -s "$BASE/api/projects/$PROJECT_ID/board/cards" | jq
```

### Create a card

```bash
curl -s -X POST "$BASE/api/projects/$PROJECT_ID/board/cards" \
  -H "Content-Type: application/json" \
  -d '{
    "title": "Short descriptive title",
    "description": "Details about the task",
    "columnId": "<column-uuid>",
    "priority": "high",
    "assignee": "your-agent-name",
    "labels": "bug,backend"
  }'
```

Priority values: `urgent`, `high`, `medium`, `low`

### Move a card between columns

```bash
curl -s -X POST "$BASE/api/projects/$PROJECT_ID/board/cards/$CARD_ID/move" \
  -H "Content-Type: application/json" \
  -d '{"columnId": "<target-column-uuid>"}'
```

### Update a card

```bash
curl -s -X PUT "$BASE/api/projects/$PROJECT_ID/board/cards/$CARD_ID" \
  -H "Content-Type: application/json" \
  -d '{"title": "Updated title", "description": "Updated details", "priority": "medium"}'
```

### Add a comment to a card

```bash
curl -s -X POST "$BASE/api/projects/$PROJECT_ID/board/cards/$CARD_ID/comments" \
  -H "Content-Type: application/json" \
  -d '{"author": "your-agent-name", "content": "PR opened: #42. Waiting on CI."}'
```

### Epics

Cards can be grouped into epics. Epics with `autonomous: true` can drive automated task dispatch.

```bash
# List epics
curl -s "$BASE/api/projects/$PROJECT_ID/board/epics" | jq

# Create an epic
curl -s -X POST "$BASE/api/projects/$PROJECT_ID/board/epics" \
  -H "Content-Type: application/json" \
  -d '{"name": "Epic Name", "description": "Goal", "color": "#3B82F6"}'

# Link a card to an epic
curl -s -X PUT "$BASE/api/projects/$PROJECT_ID/board/cards/$CARD_ID" \
  -H "Content-Type: application/json" \
  -d '{"epic_id": "<epic-uuid>"}'
```

## Wiki

Every project has a wiki with full-text search (FTS5). Use it to find and share knowledge.

### Search

```bash
curl -s "$BASE/api/projects/$PROJECT_ID/wiki?q=deployment" | jq
```

### Read a page

```bash
curl -s "$BASE/api/projects/$PROJECT_ID/wiki/page-slug" | jq
```

### List all pages (optionally filter by category)

```bash
curl -s "$BASE/api/projects/$PROJECT_ID/wiki" | jq
curl -s "$BASE/api/projects/$PROJECT_ID/wiki?category=api-docs" | jq
```

### Create a page

```bash
curl -s -X POST "$BASE/api/projects/$PROJECT_ID/wiki" \
  -H "Content-Type: application/json" \
  -d '{
    "title": "Page Title",
    "content": "# Heading\n\nMarkdown content...",
    "category": "architecture",
    "updatedBy": "your-agent-name"
  }'
```

### Update a page

```bash
curl -s -X PUT "$BASE/api/projects/$PROJECT_ID/wiki/page-slug" \
  -H "Content-Type: application/json" \
  -d '{"content": "# Updated\n\nNew content...", "updatedBy": "your-agent-name"}'
```

**Categories:** `general`, `api-docs`, `architecture`, `conventions`, `test-patterns`, `troubleshooting`, `onboarding`

> **Always search before creating** — update existing pages rather than creating duplicates.

## Sessions & Messages

You're running inside a chat session. You can also query other sessions if needed.

```bash
# List sessions for an agent
curl -s "$BASE/api/sessions?agentId=<agent-id>" | jq

# Get messages for a session
curl -s "$BASE/api/sessions/<session-id>/messages" | jq
```

## Agent Coordination Blocks

Lead agents coordinate with their sub-agents by emitting **fenced JSON blocks** in their chat output. The server parses these from the final assistant message after the CLI process closes — they are **terminal in the turn** (anything after the closing tag is dropped). All targets must be listed as sub-agents of the emitter (which implies same project).

### `<delegate>` — Parallel one-shot sub-agents

Spawn one or more sub-agents in parallel as fresh CLI processes. Each receives a self-contained `task` string; their outputs are collected and injected into the lead's next turn as a synthesized summary message. The lead stays running.

```
<delegate>
[
  {"agentId": "hub-frontend", "task": "Audit client/src/components/Chat.jsx for scroll-follow regressions."},
  {"agentId": "hub-backend",  "task": "Check if server/chat.ts still emits the old `stream_end` event."}
]
</delegate>
```

- **Payload**: JSON array of `{agentId, task}` objects. Both fields required, both strings.
- **Parallelism**: All tasks spawn concurrently (`Promise.all`). No hard cap, but keep N small (≤ 4) — every spawn is a real CLI subprocess with its own context.
- **Return shape**: A synthesis message containing per-task `{agentId, agentName, output, error}`. Failed sub-agents surface as `error`, not as an exception — the lead always gets something back.
- **When to use**: short parallel side-quests whose results you'll read and synthesize. Not for multi-turn ownership — use `<handoff>` for that.

### `<handoff>` — Ownership transfer to one specialist

End your turn and hand ownership of the conversation to a single sub-agent. A **new session** is created for the target with your transcript (tail of last 50 turns) plus the `note` pre-injected into their enriched system prompt. The user continues the conversation with the target; you do not see their reply.

```
<handoff>
{"toAgent": "hub-backend", "note": "Plan done — failing test is server/chat.test.ts:142, fix likely at server/chat.ts:754 (isAskMode branch). Linked card: 36d919a9. Please implement + PR."}
</handoff>
```

- **Payload**: single JSON object with required string fields `toAgent` and `note`. Array payloads are rejected; only one target per handoff.
- **Lifecycle** (rows in the `handoffs` table): `pending` (created) → `delivered` (target session spawned and primed) → `failed` (validation error, target not in project, or spawn failure).
- **Terminal**: anything emitted after `</handoff>` is logged and dropped.
- **When to use**: the specialist needs multiple turns, will likely commit / open a PR, or needs the full transcript as background. Prefer `<handoff>` over `<delegate>` for anything beyond a short side-quest.

### `<agenthub:close-card>` — Auto-close duplicate / already-done cards

If you pick up a kanban card and discover the work is redundant (duplicates an earlier card, or already shipped), don't leave the card parked. End your turn with:

```
<agenthub:close-card>
{"reason": "duplicate", "note": "Covered by card 5c8f2a — see PR #313.", "duplicateOfCardId": "5c8f2a..."}
</agenthub:close-card>
```

- **Fields**: `reason` ∈ {`"duplicate"`, `"already-done"`} (required), `note` (required, non-empty, one-line shown in the auto-close comment), `duplicateOfCardId` (optional canonical card id).
- **Server behavior**: finds the card linked to the current session via `kanban_cards.session_id`, moves it to the Done column, and appends an explanatory comment referencing this session. Best-effort — if there's no linked card or Done column, the chat flow is unaffected.
- **Requires**: the session must be linked to a card (it is whenever the sidebar was auto-renamed to the card title, i.e. when the card was created with `session_id: $AGENT_HUB_SESSION_ID`).

## Ask Mode — Read-Only Agent Sessions

Sessions have an `ask_mode` flag (column `sessions.ask_mode`, toggled via `PUT /api/sessions/:id/ask-mode` with `{enabled: boolean}`). When `ask_mode=1`, the Claude CLI is invoked with `--permission-mode plan` instead of `bypassPermissions`.

**What changes in ask mode:**
- **Allowed**: reading files, grep/glob, web fetch, API queries, analysis, planning, writing proposed changes into the chat as prose/diffs.
- **Not allowed without explicit approval**: executing shell commands that mutate state, editing/creating files on disk, opening PRs, spawning sub-agents, running deploys.
- Use ask mode for triage, code review, architecture discussions, or any time the user wants recommendations before any write lands.

**Detecting mode from inside a session:** check the session row's `ask_mode` field via `GET /api/sessions/:id`, or infer from behavior (file writes fail with a plan-mode prompt). Do not assume you can write just because the tool exists.

## Tool Error Self-Reporting (TOOL_ERROR)

When a tool call fails in a way that blocks progress, log a structured line into the daily notes so patterns are minable across sessions. This is currently a **convention** (no server-side parser) that feeds future Session Health tooling — keep the format exact.

**Format** (single line, pipe-delimited, six fields):

```
TOOL_ERROR | <ISO timestamp> | <tool name> | <command/action> | <exit code or error type> | <one-line summary>
```

**Example:**

```
TOOL_ERROR | 2026-04-19T02:45:00Z | Bash | npm test | exit 1 | ENOENT: tsx not found in PATH
```

**Log when:**
- A tool call exits non-zero and you can't route around it.
- A binary / dependency is missing or a permission is denied.
- You retry the same operation 3+ times — the pattern itself is signal.

**Skip when:**
- The failure is expected (e.g. `git status` shows no changes, a grep returns no matches).
- The tool succeeded but the result was empty.

**Escalation:** if the same pattern shows up across 2+ sessions, open a Backlog card tagged `tool-error` that quotes the structured lines, so the recurring failure gets triaged instead of repeatedly re-logged.

## Authentication & Multi-User Orgs (Auth Phase 3)

Agent Hub runs as a **multi-user, multi-org** system. Every JWT carries a `uid` (user id) claim alongside the user's current org context. Membership in an org determines what that user can do; requests outside any org they belong to return `403` (except the `x-api-key` break-glass header, which the server treats as Owner for all orgs — use it only for emergencies / automation).

### Roles

Three-tier hierarchy (`server/roles.ts`): **Owner** > **Admin** > **User**. Checks are hierarchical — Owner satisfies any `requireRole('X')`. Never compare role strings directly; use the server's `hasAtLeastRole` / `requireRole` helpers server-side, and call the right endpoint client-side.

### Sole-Owner protection

The server refuses to delete or demote the last Owner of an org (`countOwnersForOrg(orgId) <= 1` guard on `DELETE /users/:id` and role changes). If you need to hand off Owner, promote someone else to Owner first, then demote yourself.

### Endpoints at a glance

Prefix everything with `/api/auth`. All require auth unless flagged **public**.

| Endpoint                                       | Min role   | Purpose                                  |
| ---------------------------------------------- | ---------- | ---------------------------------------- |
| `GET  /status`, `POST /setup`, `POST /login`   | public     | bootstrap + sign-in                      |
| `GET  /me`                                     | any        | current user + role                      |
| `GET  /users`                                  | Admin      | list org members                         |
| `POST /users`                                  | Owner      | create user + membership                 |
| `PUT  /users/:id/role`                         | Admin      | change role (sole-Owner guard applies)   |
| `DELETE /users/:id`                            | Owner      | remove user (sole-Owner guard)           |
| `POST /users/:id/password`                     | self/Owner | reset password                           |
| `POST /invites`, `GET /invites`, `DELETE …`    | Admin      | invite lifecycle                         |
| `GET  /invites/:token`                         | **public** | preview invite before accepting          |
| `POST /invites/:token/accept`                  | **public** | redeem invite (per-IP rate-limited)      |
| `POST /logout`                                 | any        | revoke session                           |

Public paths live in `PUBLIC_PATHS` / `PUBLIC_PREFIXES` (`server/auth.ts`); everything else falls through `authMiddleware`.

### API-key break-glass

`x-api-key: $AGENT_HUB_API_KEY` bypasses JWT entirely and is treated as Owner. It's how sub-agents (including you, inside a session) talk to the local API. Don't ship the key to browser clients and don't log it.

## Electron Desktop Shell

Agent Hub ships as a desktop app that wraps the same Express server — the shell lives in `electron/` (`main.js` + `preload.cjs`). A few things agents should know when reasoning about bug reports or config-path issues:

- **No-Origin CORS bypass.** Browser clients are gated by `ALLOWED_ORIGINS` (see `server/cors-config.ts`). Electron and React Native requests have **no `Origin` header**, so CORS short-circuits to "allow" at the top of the cors callback. That's why the desktop shell and mobile app "just work" without being added to the allowlist — not a bug, by design.
- **Packaged vs. dev config paths.** In development (`NODE_ENV=development`), the shell resolves data paths relative to the repo (`server/` next to the sources). In a packaged build, it uses `app.getPath('userData')` (`~/Library/Application Support/Agent Hub` on macOS, `%APPDATA%/Agent Hub` on Windows, `~/.config/Agent Hub` on Linux) and serves the built client from `client/dist`. If a user reports "my config didn't carry over after upgrading" or "the app can't find my sessions", this path divergence is the usual culprit — check which build they're on before chasing data loss.
- **Releases are out-of-band.** A macOS DMG build script (`electron/release-mac.mjs`) exists for ops, but there's no in-app auto-updater wired up. **Agents don't and shouldn't trigger releases** — propose a PR, let a human run the release pipeline.

## Skills Registry

Agent Hub has a central skills registry (marketplace). You can browse it:

```bash
# List all registry skills
curl -s "$BASE/api/skills/registry" | jq

# Search by category
curl -s "$BASE/api/skills/registry?category=development" | jq
```

## Server Info

```bash
# Get server config (port, models, auth status)
curl -s "$BASE/api/config" | jq

# List all projects
curl -s "$BASE/api/projects" | jq

# List agents for a project
curl -s "$BASE/api/projects/$PROJECT_ID" | jq '.agents'
```

## Self-Reporting Best Practices

As an agent on Agent Hub, you should:

1. **Track your work** — Create kanban cards when starting significant tasks, move them as you progress.
2. **Document knowledge** — After completing work, write/update wiki pages with decisions, patterns, and solutions.
3. **Comment on cards** — When you open a PR, hit a blocker, or finish a subtask, add a comment to the relevant card.
4. **Search before asking** — Check the wiki for existing documentation before making assumptions about the codebase.

## Architecture Quick Reference

| Component  | Stack                           | Location       |
| ---------- | ------------------------------- | -------------- |
| Server     | Express.js + SQLite + WebSocket | `server/`      |
| Web Client | React + Vite + Tailwind CSS     | `client/`      |
| Mobile     | React Native + Expo             | `mobile/`      |
| Desktop    | Electron wrapper                | `electron/`    |
| Deployment | Node.js host (Nginx + process manager recommended) | `<your-host>` — see `references/deployment-example.md` |

**Database:** SQLite with WAL mode (`better-sqlite3`). Tables include `sessions`, `messages`, `heartbeat_logs`, `crons`, `wiki_pages`, `kanban_boards`, `kanban_columns`, `kanban_cards`, `kanban_epics`, `skill_registry`, `webhook_configs`, `device_tokens`.

**Real-time:** WebSocket on the same port as HTTP. Events include `message`, `session_created`, `kanban_update`, `wiki_update`, `cron_session_update`, `auto_pr_created`.
