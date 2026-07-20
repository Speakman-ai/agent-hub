---
name: agent-hub
description: >-
  Agent Hub platform core skill — env contract, auth, multi-user orgs,
  error self-reporting, Electron, and the map to four domain sub-skills
  (agent-hub-kanban, agent-hub-wiki, agent-hub-sessions,
  agent-hub-heartbeats-crons). Covers the Agent Hub API at
  http://localhost:3051, kanban boards, epics, per-project wiki (FTS5),
  sessions, heartbeats, crons, and delegation via <delegate> / <handoff> /
  <agenthub:close-card>. TRIGGER on Agent-Hub signals: env vars
  AGENT_HUB_URL / AGENT_HUB_API_KEY / AGENT_HUB_SESSION_ID / PROJECT_ID;
  URLs under localhost:3051 or /api/projects/<slug>/; the name "Agent Hub";
  or wrappers scripts/server.sh, scripts/log-tool-error.sh. DO NOT TRIGGER
  on third-party trackers (Linear, Jira, Trello, Asana, GitHub Projects),
  wikis (Notion, Confluence), or APIs (GitHub, Slack, Stripe, AWS) unless
  about Agent Hub's own integration; on generic Bash/git/Node help; or on
  the Claude Code CLI / Agent SDK alone — coincidental vocabulary is not a
  trigger.
category: platform
version: 3.0.0
keep-coding-instructions: true
---

# Agent Hub — Core

You are an AI agent running inside **Agent Hub**, a full-stack platform for
managing AI agents. This skill is the **core entry point**: env contract,
auth, error self-reporting, and a map to four domain sub-skills.

> **Never paste raw `curl` into the chat.** The wrappers under `scripts/`
> are the single source of truth and already handle base URL, auth, and
> JSON bodies. If a wrapper is missing, add it.

> **Script-path contract — wrappers are on `PATH`.** The server prepends the
> bundled skill's `scripts/` dir to every spawn's `PATH` and exports its root
> as **`$AGENT_HUB_SKILLS_DIR`**. Call wrappers by **bare name** (`board.sh`,
> `wiki-search.sh`, `server.sh`) from any CWD — no `scripts/` prefix, never
> `find /`. On a "command not found", use `"$AGENT_HUB_SKILLS_DIR"/scripts/<name>.sh` and report the PATH miss.

> **API contract reference.** Every endpoint's request/response shape is
> published at <https://speakman-ai.github.io/agent-hub/> (auto-generated
> from the Zod registry, with `x-internal: true` operations stripped, kept
> fresh by the CI freshness gate). Treat the script wrappers as the *how*
> and that page as the *what* — `WebFetch` it (or its deep-link anchors
> like `#tag/Board`, `#tag/Agents`, `#tag/Sessions`) when you need a shape
> a wrapper doesn't cover. Wrappers stay primary; OpenAPI is the fallback
> for shape lookup.

## Domain sub-skills

Load the sub-skill that matches the work you're doing. They each carry
their own `references/<domain>.md` and trigger only on domain vocabulary.

| Skill | Domain |
| --- | --- |
| `agent-hub-kanban` | Cards, columns, comments, epics, blockers, Done-state contract |
| `agent-hub-wiki` | FTS5 search, pages, categories, slug conventions |
| `agent-hub-sessions` | Messages, ask mode, `<delegate>` / `<handoff>` / `<agenthub:close-card>` |
| `agent-hub-heartbeats-crons` | Scheduled agents, threads, persistent logs |

To load one mid-turn, end your turn with:

```
<agenthub:skill>
{"name":"agent-hub-kanban","reason":"need to move a card"}
</agenthub:skill>
```

## Environment

All scripts read these env vars:

| Variable | Default | Notes |
| --- | --- | --- |
| `AGENT_HUB_URL` | Loopback `http://127.0.0.1:<port>` | Server-injected REST base. Defaults to loopback; for remote workers set `AGENT_HUB_PUBLIC_URL` / `publicUrl` or `AGENT_HUB_AGENT_URL` / `agentHubUrl` in config. |
| `AGENT_HUB_API_KEY` | (injected by the server) | Sent as `x-api-key`; treated as Owner for all orgs. |
| `PROJECT_ID` | (required) | Slug from the system prompt, e.g. `agent-hub`. |
| `AGENT_HUB_SESSION_ID` | (injected) | Your session id. Pass when creating cards to auto-link. |
| `AGENT_HUB_SKILLS_DIR` | (injected) | Absolute path to the bundled `agent-hub` skill. Its `scripts/` dir is also prepended to `PATH`, so wrappers run by bare name. |
| `AGENT_HUB_CODEX_DANGER_BYPASS` | `true` (server default) | Server-only: when true (`1`/`true`/`on`, or unset), interactive Codex spawns use `--dangerously-bypass-approvals-and-sandbox` outside Ask Mode instead of `--full-auto` (needed when Linux bubblewrap cannot create user namespaces). Set `false`/`0`/`off` to opt into Codex's sandbox. Same as `codexDangerBypass` in host `config.json` or `PATCH /api/config`. Applies to chat, conference rooms, Design Studio, and `<delegate>` sub-agent runs plus delegation synthesis when the lead engine is Codex. |

Identify yourself / the project:

```bash
scripts/server.sh config     # port, models, auth status
scripts/server.sh projects   # list projects
scripts/server.sh agents     # list all agents
```

## Authentication & multi-user orgs

Full reference: **[references/auth.md](references/auth.md)**.

Agent Hub is multi-user / multi-org. JWTs carry a `uid` claim and a
current org context. Role hierarchy: **Owner > Admin > User** (see
`server/roles.ts`). Sole-Owner deletion/demotion is refused. The
`x-api-key` header is a break-glass that the server treats as Owner for
every org — sub-agents (including you) use it to call the local API.
The reference also covers per-user `ahub_*` API keys, config-file
locations, mid-flight `/api/auth/setup` recovery, and the `trust proxy`
coupling that per-IP rate limiters depend on.

## Agents — config, sessions, dispatch

Full reference: **[references/agents.md](references/agents.md)**.

The `agents` table is the per-project agent registry: identity, engine,
default model, workspace `cwd`, and context-file paths. Endpoints under
`#tag/Agents` cover CRUD plus the session-creation surface that
`agent-hub-sessions` builds on; kanban cards reference sessions via
`session_id`, not via the agent-session API. Spawn
identity (`owner_user_id`), workspace resolution, and the reviewer-lock
contract live in the reference.

## Errors — self-reporting & common failure modes

Full reference: **[references/errors.md](references/errors.md)**.

When a tool call blocks progress, log a pipe-delimited, one-line record
into today's daily note so future Session Health tooling can mine
patterns. **Run `scripts/log-tool-error.sh`** — it mints the timestamp,
sanitises pipes/newlines, and appends under `## HH:MM`. Default is the v1
six-field line; pass `--sev`, `--resolution`, `--session-id`, `--tag` to
emit a v2 JSON-tail line:

```bash
PROJECT_ID=agent-hub scripts/log-tool-error.sh \
  --tool Bash --action 'npm test' --exit 'exit 1' \
  --summary 'ENOENT: tsx not found in PATH'
```

The reference also lists common failure modes (auth `401`/`403`, missing
`PROJECT_ID`, column-name typos, wiki `409`, undispatched
`<delegate>`/`<handoff>`, plan-mode blocks, `429` rate limits, WebSocket
mid-stream drops) with the recovery step that usually unsticks them.

## Self-reporting checklist

1. **Create** a kanban card when picking up significant work (pass
   `session_id: $AGENT_HUB_SESSION_ID` to auto-link). See
   `agent-hub-kanban`.
2. **Move** the card to In Progress when you start. Do **not** move it to
   Done yourself — Done means merged; the platform closes the card when
   your change lands.
3. **Comment** on the card when opening a PR, hitting a blocker, or
   finishing a subtask.
4. **Search the wiki** before asking; **update** existing pages rather
   than duplicating. See `agent-hub-wiki`.
5. **Log** `TOOL_ERROR` lines when tool failures block you.

## Artifacts — share generated documents

When you generate a document the user should be able to view or download
(a PDF, a report, a script, a build log, an exported CSV…), publish it as a
**session artifact** with `scripts/artifacts.sh`. Uploaded artifacts show up
in the session's **Artifacts panel** in the web/mobile/Electron UI, and you
can read them back later in the same or a follow-up turn.

```bash
scripts/artifacts.sh put ./report.pdf "Q2 report"   # upload (prints metadata JSON)
scripts/artifacts.sh list                            # list this session's artifacts
scripts/artifacts.sh get <artifactId> ./out.pdf      # download bytes back to a file
scripts/artifacts.sh delete <artifactId>             # remove one
```

Everything is scoped to `$AGENT_HUB_SESSION_ID`. Executables / native binaries
and files over 100 MB are rejected. Storage is S3 when the Hub is configured
with an artifacts bucket, otherwise a local directory — either way you use the
same script.

## Background shells — run work that outlives the turn

A normal `run_in_background: true` Bash shell is a grandchild of **this turn's**
CLI process, which the Hub reaps when the turn ends — so you can't `BashOutput`
it next turn. To run something you'll monitor across turns (a build, a watcher,
a long test run), start it as a **Hub-owned background shell** with
`scripts/bg.sh`. It runs in the session worktree, its output streams to the
session's **Background shells panel**, and `status` / `logs` / `stop` keep
working in later turns.

```bash
scripts/bg.sh start --label "prod build" npm run build  # start (prints shell JSON incl. id)
scripts/bg.sh list                                       # this session's shells (JSON)
scripts/bg.sh status <shellId>                           # one shell's status
scripts/bg.sh logs <shellId> --limit 100                 # captured output tail
scripts/bg.sh stop <shellId>                             # SIGTERM the process group
```

Everything is scoped to `$AGENT_HUB_SESSION_ID`. Statuses are `running`,
`exited` (clean, code 0), `failed` (non-zero / crashed), or `stopped` (you
stopped it). The Hub reaps every running shell when the session is archived.

## Workflows — worked examples

Concrete recipes live under **[examples/](examples/)**:

| Recipe | When to use |
| --- | --- |
| [create-ticket-from-bug-report](examples/create-ticket-from-bug-report.md) | User drops a bug report and wants a kanban card created |
| [delegate-to-subagent](examples/delegate-to-subagent.md) | Fan out parallel audits via `<delegate>` |
| [post-heartbeat-summary](examples/post-heartbeat-summary.md) | End a heartbeat run with a structured thread summary |
| [search-and-link-wiki-page](examples/search-and-link-wiki-page.md) | FTS-search the wiki and link the page in a card comment |
| [move-card-through-workflow](examples/move-card-through-workflow.md) | Walk a card To Do → In Progress (merge writes Done) |

## Architecture quick reference

| Component | Stack | Location |
| --- | --- | --- |
| Server | Express.js + SQLite (WAL) + WebSocket | `server/` |
| Web Client | React + Vite + Tailwind | `client/` |
| Mobile | React Native + Expo | `mobile/` |
| Desktop | Electron wrapper (`electron/main.js`) | `electron/` |
| Deployment | Self-hosted Node.js behind a TLS proxy | operator |

**Persistence:** SQLite stores sessions, messages, wiki, kanban, schedules,
artifacts, credentials, and integration state. **Real-time:** WebSocket shares
the HTTP port and broadcasts chat, session, kanban, wiki, cron, and preview
updates. **Desktop:** Electron wraps the server; packaged config lives under
`app.getPath('userData')`. Releases are out-of-band; humans publish installers.
