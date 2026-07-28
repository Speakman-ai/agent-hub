# Sessions — Messages & Ask Mode

You're running inside a session. The `sessions` table tracks the
session; `messages` stores the per-turn message log. You can query other
sessions too — useful for triage and cross-session analysis.

Back to [SKILL.md](../SKILL.md).

**Endpoint contracts:** <https://speakman-ai.github.io/agent-hub/#tag/Sessions>
(request/response shapes for session CRUD, messages, ask-mode). This page is
the *how*.

## Contents

- [Listing sessions & messages](#listing-sessions--messages)
- [Session row](#session-row)
- [Message row](#message-row)
- [Per-user session ownership](#per-user-session-ownership)
- [Ask mode — read-only / plan-mode sessions](#ask-mode--read-only--plan-mode-sessions)
  - [What changes in ask mode](#what-changes-in-ask-mode)
  - [Detecting ask_mode from inside a session](#detecting-ask_mode-from-inside-a-session)
  - [Flipping ask mode programmatically](#flipping-ask-mode-programmatically)
- [ReAct loop — host-mediated skill/wiki/web actions](#react-loop--host-mediated-skillwikiweb-actions)
- [No app-level sub-agent dispatch](#no-app-level-sub-agent-dispatch)
- [Action blocks](#action-blocks)
  - [`<agenthub:close-card>` — auto-close duplicate / already-done cards](#agenthubclose-card--auto-close-duplicate--already-done-cards)

## Listing sessions & messages

```bash
scripts/sessions.sh list <agentId>           # sessions for a given agent
scripts/sessions.sh messages <sessionId>     # full message history
```

## Session row

Notable columns: `id`, `agent_id`, `engine` (`claude-code` | `cursor-agent` | `gemini-cli`), `model`,
`use_worktree` (0/1 — per-session git isolation; new rows default from the project's `mode`),
`ask_mode` (0/1 — see below), `react_loop_enabled` (0/1 — see
[ReAct loop](#react-loop--host-mediated-skillwikiweb-actions)), `created_at`, `updated_at`, `title`,
`last_message_at`.

Task planning within a turn is owned by the engine’s native todo / scratch flow — Agent Hub does not persist a parallel task-state column or sidebar panel.

## Message row

`messages` holds `id`, `session_id`, `role` (`user` | `assistant` |
`system`), `content`, `tool_calls` (JSON blob when applicable), and
timestamps. Messages are stored in order; there's no separate turn index.

## Per-user session ownership

Each `sessions` row carries an `owner_user_id` column populated from
the caller that created it. Ownership is **strict** — only the
recorded owner can read or mutate the session, message log, tasks,
forwards, and the WebSocket `chat` / `cancel` surface.
Non-owners get **404 Not Found** (not 403) so foreign sessions can't
be probed for existence.

Ownership rules:

- **Interactive spawns** (REST + WebSocket): owner = caller's
  `req.authUserId` from the verified JWT. Local-bundled mode (Electron
  / dev box) and apiKey callers, which lack a per-user identity,
  resolve to the org owner — single-tenant installs keep working.
- **System spawns** (cron, heartbeat, webhook reviewer, autonomous
  dispatch, bug-report intake): owner = the org owner (oldest user in
  `users.created_at ASC`). Net effect in strict mode: only the owner
  sees these sessions in `GET /api/sessions/cron` and friends.
- **Child sessions** (`/forward` clone): inherit the parent's owner via
  `inheritOwnerFromSession` in `routes/sessions.ts`. A specialist picking
  up a forwarded transcript stays scoped to whoever started the
  conversation.
- **Pre-migration NULL owners**: treated as belonging to the org owner
  so legacy rows stay accessible after the upgrade. The startup
  `backfillSessionOwners()` then replaces every NULL with that user.

Helpers live in `server/session-ownership.ts` —
`userOwnsSession(req, sessionId)`, `setSessionOwner(id, ownerId)`,
`inheritOwnerFromSession(target, source)`,
`resolveOwnerUserId(req)`. The org-owner lookup is cached for the
process lifetime once a positive result is known; negative lookups
are not memoised so a `/api/auth/setup` immediately after boot is
visible without a process restart.

## Ask mode — read-only / plan-mode sessions

Sessions carry an `ask_mode` flag (`sessions.ask_mode` column, toggled via
`PUT /api/sessions/:id/ask-mode` with `{enabled: boolean}`). When
`ask_mode=1`, the Claude CLI is invoked with `--permission-mode plan`
instead of `bypassPermissions`.

Use `scripts/sessions.sh ask-mode <sessionId> true|false` from the command
line. Never call the endpoint inline.

### What changes in ask mode

- **Allowed**: reading files, grep/glob, web fetch, API queries, analysis,
  planning, writing proposed changes into the chat as prose/diffs.
- **Not allowed without explicit approval**: executing shell commands that
  mutate state, editing/creating files on disk, opening PRs, spawning
  sub-agents, running deploys.

Use ask mode for triage, code review, architecture discussions, or any time
the user wants recommendations before any write lands. The session is
effectively **read-only** (analysis and planning only).

### Detecting ask_mode from inside a session

- Query the session row: `GET /api/sessions/:id` → `ask_mode`.
- Infer from behavior: file writes fail with a plan-mode prompt.

Do not assume you can write just because the tool exists. If you're in
plan mode and need to mutate, surface a clear proposal and wait for the
user to flip the mode.

### Flipping ask mode programmatically

Only do this at the user's explicit request, because it changes the
contract of the in-flight session:

```bash
scripts/sessions.sh ask-mode <sessionId> true    # enter plan mode
scripts/sessions.sh ask-mode <sessionId> false   # resume normal permissions
```

## ReAct loop — host-mediated skill/wiki/web actions

Sessions also carry a `react_loop_enabled` flag (`sessions.react_loop_enabled`
column, default `1`, toggled via `PUT /api/sessions/:id/react-loop` with
`{enabled: boolean}`). When enabled, the host parses a terminal
`<agenthub:react>` block from the assistant's last turn and executes the
listed actions (`wiki` hybrid retrieval, `skill` loading, `web` search via
Serper) before optionally **auto-continuing** the same turn with the new
context appended to `pending_skill_context`.

Auto-continuation is bounded by three budgets so a runaway agent can't
consume the session:

- `MAX_AUTO_CONTINUATION_DEPTH` — hard cap on how many synthetic
  continuation turns we'll string together (prevents infinite tool →
  continue → tool loops).
- `AUTO_CONTINUATION_MAX_RETRIES` — when a continuation is scheduled but
  the session still has an active task, the handler reschedules itself up
  to this many times (500ms each) before
  dropping the continuation. The pure planner `planAutoContinuationRetry`
  in `server/chat.ts` encodes this decision so the cap is covered by unit
  tests rather than wall-clock `setTimeout` behavior.
- `MAX_REACT_ACTIONS_PER_TURN` — ReAct blocks with too many actions are
  rejected at parse time; even if one slips through, the executor slices
  the action list to this bound.

When `react_loop_enabled=0` the host falls back to the legacy
`<agenthub:skill>` and `<agenthub:wiki>` single-action paths and never
auto-continues. Per-session web-search and wiki-hybrid-RAG budgets are
enforced independently of this flag.

### Skill loading: `<agenthub:skill>` only — native `Skill` tool is disabled

Every Claude Code spawn that runs an Agent-Hub-enriched system prompt is
launched with `--disallowed-tools Skill` (helper:
`server/claude-cli-args.ts → disableNativeSkillToolArgs()`). This covers
the chat session, conference rooms, `runClaude` (heartbeats / crons /
workflow steps), Slack one-shots, the memory reconciliation pass, and
Design Studio.

The reason is that Agent Hub's per-agent skill registry includes skills
that are **not** in Claude Code's bundled list (`aws-infra`, `design`,
`designs`, etc.). Calling the native `Skill` tool with one of those names
returned `<tool_use_error>Unknown skill: …</tool_use_error>`, surfaced as
"Couldnt find tool skill" in the UI, and burned a turn. Routing skill
loads exclusively through `<agenthub:skill>` (or the `skill` action inside
`<agenthub:react>`) is the documented gateway and the only one that
works. Bash, WebFetch, and the rest of the tool surface are untouched.

**Argv-ordering gotcha (Claude CLI 2.x).** `--disallowed-tools <tools...>`
is **variadic** in Commander.js — it keeps consuming bare positionals
until it hits another `--option` or a `--` end-of-options separator. So
`--print … --disallowed-tools Skill <prompt>` is parsed as
`disallowed-tools = ["Skill", "<prompt>"]` with **zero** positional prompt
and the CLI exits with `Error: Input must be provided either through
stdin or as a prompt argument when using --print`. Spawn sites whose
argv ends with a bare positional prompt (heartbeat / memory / slack /
room-chat) **must** insert `'--'` between `disableNativeSkillToolArgs()` and the
prompt push. Sites that already have an intervening `--option` (e.g.
`--session-id`/`--resume` between the helper call and the prompt — chat
session, design-multi-engine) are safe without `'--'` because the next
flag terminates the variadic. The
`server/claude-cli-args.test.ts` regression test source-greps every
occurrence of `disableNativeSkillToolArgs()` in the bare-prompt files
and pins each one independently.

## No app-level sub-agent dispatch

Agent Hub has no block for spawning a sub-agent or transferring ownership
of a session. That dispatch system was removed; emitting the old tags gets
you a system message saying so and nothing else. Agents are peers and
coordinate through plain chat, kanban assignment, the Forward Session flow,
multi-agent sessions, and conference rooms. The CLI engines (Claude Code,
Cursor, Codex) run their own internal sub-agent orchestration, which is
separate and unaffected.

## Action blocks

The server parses action blocks from the final assistant message after the
CLI process closes — they are **terminal in the turn** (anything after the
closing tag is dropped). Parsing lives in `server/chat.ts`.

**Payload normalization (tolerant pre-pass).** All action-block parsers
(`<agenthub:close-card>`, `<agenthub:skill>`, `<agenthub:react>`) route the
raw tag body through
`server/action-block-parsing.ts#extractJsonFromTagBody` before
`JSON.parse`. The helper:

1. Strips an outer markdown fence (`` ```json … ``` ``) if the body is
   wrapped in one.
2. Slices the first balanced JSON object/array, skipping any lead-in
   prose between the opening tag and the JSON.
3. Re-encodes raw control characters (`\n`, `\r`, `\t`, `\f`, `\b`)
   that appear **inside JSON string values** — RFC 8259 §7 forbids
   them, but agents emit them often, especially in `note` fields.

If the helper returns `null`, the parser falls back to a direct
`JSON.parse` on the raw body so genuinely malformed payloads still hit
the existing **invalid-json** rejection gates (which persist a system
message back to the session). The pre-pass is purely additive — every
shape that parsed before still parses now.

### `<agenthub:close-card>` — auto-close duplicate / already-done cards

If you pick up a kanban card and discover the work is redundant
(duplicates an earlier card, or already shipped), don't leave the card
parked. End your turn with a fenced `<agenthub:close-card>` block whose
body is a JSON object with `reason` and `note`. Malformed JSON or missing
required fields is rejected with a **Card close gate rejected** system
message — the linked card is **not** moved.

```
<agenthub:close-card>
{"reason":"duplicate","note":"Covered by card 5c8f2a — see PR #313.","duplicateOfCardId":"5c8f2a..."}
</agenthub:close-card>
```

- **Fields**:
  - **`reason`** ∈ {`"duplicate"`, `"already-done"`} (required).
  - **`note`** (required, non-empty) — one line shown in the auto-close comment.
  - **`duplicateOfCardId`** (optional) — canonical card id when `reason` is
    `"duplicate"`.
- **Server behavior**: finds the card linked to the current session via
  `kanban_cards.session_id`, then moves it to the board’s **Done** column and
  appends an audit comment (best effort). In-repo verification is expected from
  **CI, pre-commit hooks, and human review** — the host does not run a separate
  in-session “verify before Done” command pipeline.
- **Requires**: the session must be linked to a card (it is whenever the
  sidebar was auto-renamed to the card title, i.e. when the card was
  created with `session_id: $AGENT_HUB_SESSION_ID`).
