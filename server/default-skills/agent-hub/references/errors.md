# Errors — Self-Reporting & Common Failure Modes

Tool calls fail. The important thing is that when one blocks progress, you
log it in a way future Session Health tooling can mine, and you know the
two or three recovery steps that usually unstick the common failures.

Back to [SKILL.md](../SKILL.md).

## Contents

- [TOOL_ERROR self-reporting](#tool_error-self-reporting)
  - [Format](#format)
    - [v1 — legacy](#v1--legacy)
    - [v2 — structured metadata via JSON tail](#v2--structured-metadata-via-json-tail)
  - [How to log — `scripts/log-tool-error.sh`](#how-to-log--scriptslog-tool-errorsh)
  - [When to log](#when-to-log)
  - [When to skip](#when-to-skip)
  - [Escalation](#escalation)
  - [Migration — v1 → v2](#migration--v1--v2)
- [Common failure modes](#common-failure-modes)
  - [401 / 403 from the local API](#401--403-from-the-local-api)
  - [`PROJECT_ID` unset or wrong slug](#project_id-unset-or-wrong-slug)
  - [Column name not found when moving a card](#column-name-not-found-when-moving-a-card)
  - [Wiki create returns 409 (slug collision)](#wiki-create-returns-409-slug-collision)
  - [`<delegate>` / `<handoff>` never dispatched](#delegate--handoff-never-dispatched)
  - [Plan mode blocks a write](#plan-mode-blocks-a-write)
  - [Rate limit (`429`) from auth routes](#rate-limit-429-from-auth-routes)
  - [WebSocket stream closes without a final message](#websocket-stream-closes-without-a-final-message)

## TOOL_ERROR self-reporting

When a tool call fails in a way that blocks progress, log a structured line
into your daily notes so patterns are minable across sessions. The parser
lives in `server/tool-errors.ts`; the Session Health dashboard consumes the
same rows. Two wire formats are accepted during the transition window (see
[Migration — v1 → v2](#migration--v1--v2) below):

- **v1** (legacy, 6 pipe-delimited fields) — still honoured by the parser.
- **v2** (6 fields + optional JSON tail) — preferred for new entries; lets
  you record severity, resolution, session correlation, retry counter, and
  freeform tags without smuggling them into the free-text summary.

### Format

#### v1 — legacy

Single line, **pipe-delimited**, six fields:

```
TOOL_ERROR | <ISO timestamp> | <tool name> | <command/action> | <exit code or error type> | <one-line summary>
```

Example:

```
TOOL_ERROR | 2026-04-19T02:45:00Z | Bash | npm test | exit 1 | ENOENT: tsx not found in PATH
```

The parser treats a v1 line as a v2 line with `{"v":1,"sev":"blocked","resolution":"unresolved"}`
defaults — a conservative "block, not yet resolved" bucket that matches the
historical "only log blocking failures" convention.

#### v2 — structured metadata via JSON tail

Same six fields, plus an optional **7th field** that is a JSON object.
The object MUST start with `{` and end with `}` on the same line; any raw
`|` characters inside JSON string values are preserved because the parser
peels the tail atomically before splitting positional fields:

```
TOOL_ERROR | <ISO timestamp> | <tool> | <action> | <exit/type> | <summary> | {"v":2,...}
```

Example (soft failure that auto-recovered, correlated to a session + tagged):

```
TOOL_ERROR | 2026-04-17T21:18:19Z | aws-ssm | deploy-dev run 24587084751 | exit 1 | PAM session-close; deploy itself succeeded | {"v":2,"sev":"soft","resolution":"recovered","session":"05d84ec4","agent":"hub-backend","tags":["deploy","aws"]}
```

##### v2 JSON-tail fields

All fields are optional; the parser fills sensible defaults when any are
absent. Unknown keys are preserved under `meta.extras` so future additions
don't require another migration.

| Key          | Type                                                                          | Default        | Meaning                                                                 |
| ------------ | ----------------------------------------------------------------------------- | -------------- | ----------------------------------------------------------------------- |
| `v`          | `2`                                                                           | `2`            | Wire-format version. Always write `2` when you emit a JSON tail.        |
| `sev`        | `"blocked"` \| `"soft"` \| `"retry"`                                          | `"blocked"`    | Did this block progress, was it absorbed, or is it a repeat-retry flag? |
| `resolution` | `"unresolved"` \| `"recovered"` \| `"escalated"` \| `"duplicate"` \| `"preexisting"` | `"unresolved"` | Terminal disposition when the line was written.                         |
| `session`    | string                                                                        | —              | Session id that hit the error (usually `$AGENT_HUB_SESSION_ID`).        |
| `agent`      | string                                                                        | —              | Agent slug that logged the error.                                       |
| `attempt`    | integer                                                                       | —              | Retry counter. Pair with the "3+ retries" rule in [When to log](#when-to-log). |
| `tags`       | string[]                                                                      | —              | Freeform cohort tags (e.g. `["ci","deploy","auth"]`).                   |
| `card`       | string                                                                        | —              | Kanban card id this error scopes to.                                    |
| `pr`         | string                                                                        | —              | PR URL this error scopes to.                                            |

##### Severity vocabulary

- **`blocked`** — the failure stopped the agent from making progress. The
  historical v1 default. This is the bucket to mine for "must fix" work.
- **`soft`** — the tool reported failure but the surrounding step still
  completed (e.g. post-deploy cleanup returned non-zero but the deploy
  itself succeeded; a linter flagged a stylistic nit the agent fixed
  immediately). Useful for catching noisy tools that cry wolf.
- **`retry`** — use when logging at the 3+ retry threshold. `attempt` goes
  hand in hand with this value.

##### Resolution vocabulary

- **`unresolved`** — the failure is still in effect at the time of logging.
- **`recovered`** — the agent routed around it and work continued.
- **`escalated`** — the agent opened a Backlog card / asked a human.
- **`duplicate`** — the error duplicates an existing logged line this
  session (link the prior `timestamp` or `card` in a comment).
- **`preexisting`** — the failure predates the agent's current work and
  isn't scoped to this ticket. Use sparingly — it's the right bucket when
  a test file is already red on `main` and you're not here to fix it.

### How to log — `scripts/log-tool-error.sh`

**Don't hand-roll the line.** Call `scripts/log-tool-error.sh` — it
generates the UTC ISO timestamp, sanitises stray pipes/newlines in the
positional fields, JSON-encodes any v2 metadata you pass, and appends the
entry under a fresh `## HH:MM` header to
`<workspace>/memory/<YYYY-MM-DD>.md`. The workspace is resolved via
`GET /api/projects/$PROJECT_ID` so the script works no matter your CWD.

```bash
# v1 line — backward-compatible default (emit this if you don't have
# structured metadata to hand).
PROJECT_ID=agent-hub scripts/log-tool-error.sh \
  --tool Bash \
  --action 'npm test' \
  --exit 'exit 1' \
  --summary 'ENOENT: tsx not found in PATH'

# v2 line — passing any structured flag switches the writer to v2. The
# JSON tail is appended as the 7th pipe-delimited field.
PROJECT_ID=agent-hub scripts/log-tool-error.sh \
  --tool aws-ssm \
  --action 'deploy-dev run 24587084751' \
  --exit 'exit 1' \
  --summary 'PAM session-close; deploy itself succeeded' \
  --sev soft --resolution recovered \
  --session-id "$AGENT_HUB_SESSION_ID" \
  --tag deploy --tag aws
```

The script echoes the exact line it wrote to stdout (handy for piping
into a card comment or another script). It exits `2` on bad invocation
(missing required flag, bad enum value, bad `--attempt`, no `PROJECT_ID`)
and non-zero on API or filesystem failure — if the log itself fails, fall
back to emitting the line into chat so a human can transcribe it.

### When to log

- A tool call exits non-zero and you cannot route around it.
- A binary / dependency is missing or a permission is denied.
- You retry the same operation 3+ times — the pattern itself is signal;
  emit `--sev retry --attempt <n>`.
- A noisy soft failure that you absorbed but future tooling should still
  notice — emit `--sev soft --resolution recovered`.

### When to skip

- The failure is expected (e.g. `git status` shows no changes, a grep
  returns no matches).
- The tool succeeded but the result was empty.
- A preexisting failure unrelated to the current work — unless you want
  Session Health to count it, in which case emit
  `--sev soft --resolution preexisting` so it lands in the right bucket.

### Escalation

If the same pattern shows up across 2+ sessions, open a Backlog card tagged
`tool-error` that quotes the structured lines, so the recurring failure
gets triaged instead of repeatedly re-logged. Use `scripts/board.sh create`
to open the card, and record the card id in the v2 tail of future
occurrences via `--card <id>` so Session Health can group them.

### Migration — v1 → v2

- **The writer still emits v1 by default.** Passing no v2 flags produces an
  unchanged six-field line. Existing agents that don't know about v2 keep
  working and their output is indistinguishable from last month's notes.
- **The parser handles both.** `parseToolErrorsFromNote` returns a unified
  `ToolError` shape with a `meta` object on every row. v1 rows get
  `{v:1, sev:"blocked", resolution:"unresolved"}`; v2 rows get whatever the
  tail encoded. No historical notes need rewriting — v1 lines are parsed
  in place as "v2 with defaults".
- **Agents picking up v2 should opt in on new work.** Start adding `--sev`
  and `--resolution` to your invocations. Correlate to your session with
  `--session-id "$AGENT_HUB_SESSION_ID"` — it makes `countsBySeverity` and
  `countsByResolution` meaningful once the corpus tilts v2.
- **No flag day.** The transition window is open-ended. When the Session
  Health epic lands it will read both formats from the aggregator, so
  there's no deadline on this migration. If v1 lines ever drop below a
  cohort-size threshold, we'll revisit — until then both formats remain
  first-class.
- **Backfill.** Historical v1 lines are re-interpreted on the fly via the
  default-meta shim; we do **not** rewrite old daily notes. If you need
  v2-shaped data for a past failure, emit a fresh v2 line that references
  the earlier timestamp in `--tag` (e.g. `--tag backfill:2026-04-15`).

## Common failure modes

Each entry lists the **symptom**, the **most likely cause**, and the
**recovery step** that fixes it most of the time. If the recovery doesn't
work, log a `TOOL_ERROR` and escalate.

### 401 / 403 from the local API

- **Symptom**: `curl` or a wrapper returns `401 Unauthorized` or
  `403 Forbidden`.
- **Cause**: `AGENT_HUB_API_KEY` is unset or the header wasn't forwarded.
  The server treats `x-api-key: $AGENT_HUB_API_KEY` as Owner; without it,
  your request falls through to JWT-only paths.
- **Recovery**: re-source the environment (`env | grep AGENT_HUB`) and use
  one of the `scripts/*.sh` wrappers — they set the header from
  `scripts/_common.sh` automatically.

### `PROJECT_ID` unset or wrong slug

- **Symptom**: `404 project not found`, or a board call returns an empty
  columns array.
- **Cause**: `PROJECT_ID` defaults to nothing; wrappers that require a
  project slug bail out or hit the wrong project.
- **Recovery**: run `scripts/server.sh projects` to list slugs, export
  `PROJECT_ID=<slug>`, retry. For one-off calls, pass `--project <slug>`
  where the wrapper supports it.

### Column name not found when moving a card

- **Symptom**: `scripts/kanban-move-card.sh <id> "Review"` returns
  `column not found` or a 400.
- **Cause**: column UUIDs are per-project — a project that was re-created
  has new IDs. Capitalisation on the name must also match exactly.
- **Recovery**: `scripts/board.sh get | jq '.columns[] | {id, name}'` to
  see live names/IDs, then re-issue the move with the canonical name.

### Wiki create returns 409 (slug collision)

- **Symptom**: `scripts/wiki.sh create` returns `409 slug already exists`.
- **Cause**: a page with the same title already exists; the wiki never
  overwrites on create.
- **Recovery**: search first (`scripts/wiki-search.sh "title"`), then
  **update** the existing page (`scripts/wiki.sh update <slug>`). If the
  old page is genuinely stale, update its body in place — don't create a
  duplicate under a forked slug.

### `<delegate>` / `<handoff>` never dispatched

- **Symptom**: you emitted the fenced block but no sub-agent session
  appeared in the sidebar.
- **Cause**: the block was followed by additional output (both are
  **terminal in the turn**; anything after the closing tag is dropped),
  or the `agentId` / `toAgent` is not a sub-agent of the current project.
- **Recovery**: re-emit the block as the very last thing in your turn. Run
  `scripts/server.sh agents` to confirm the target agent id. For
  `<handoff>`, check the `handoffs` table — a row with `status = 'failed'`
  carries the validation error.

### `<delegate>` dispatch failed after retries

- **Symptom**: the synthesis that follows your `<delegate>` block contains
  a section like `⚠️ Error: Delegation to <agent> failed after 3
  attempts: …` and no useful output from the sub-agent.
- **Cause**: the CLI subprocess for the sub-agent failed on every
  attempt — non-zero exit with no stdout, spawn error (e.g. missing
  `claudeBin`), or timeout. The dispatcher retries up to
  `delegationMaxAttempts` (default 3, linear backoff via
  `delegationRetryBackoffMs`) before giving up; **user cancellation** is
  terminal and is never retried (see below). On **retry exhaustion** the
  server:
  - tags the `delegations` row `status = 'error'` with the descriptive
    message,
  - emits `delegation_agent_error` with `attempts: N`,
  - appends a structured `TOOL_ERROR | … | delegation | <agentId>:<task>
    | dispatch_failed | … (attempts=N)` line to the project's daily note.
- **Recovery**: check `claudeBin` in `~/.agent-hub/data/config.json`, then
  look at the daily-note `TOOL_ERROR` entry for the exact failure
  (ENOENT, timeout, non-zero exit). If the CLI itself is broken, fix
  that first; otherwise re-emit the `<delegate>` block in a follow-up
  turn. The lead already sees the error via synthesis, so acknowledge
  and decide — don't silently re-dispatch the same failing task.

### `<delegate>` cancelled mid-flight (user stop)

- **Symptom**: `delegation_cancelled` in the client; synthesis text
  explicitly tells the **lead** to take over; `delegations` rows show
  `status = 'cancelled'` (not `error`).
- **Cause**: the user stopped delegation or interrupted while sub-agent
  CLIs were still running. `handleDelegationCancel` in `server/delegation.ts`
  signals each subprocess, updates the DB, and broadcasts
  `delegation_cancelled`. Per-task `delegation_agent_error` is **not**
  emitted for user cancel (avoids the UI flipping a row from cancelled
  styling back to error).
- **Recovery**: the next synthesis turn uses **lead takeover** prompt text
  (`buildDelegationSynthesisPrompt`): carry out the delegated `task`
  strings yourself in the lead session — the work is not dropped.

### Plan mode blocks a write

- **Symptom**: file writes, shell mutations, or PR creation fail with a
  plan-mode prompt even though the tool exists.
- **Cause**: the session's `ask_mode` flag is `1`; the Claude CLI is
  running with `--permission-mode plan`.
- **Recovery**: surface a clear proposal in chat and ask the user to flip
  the mode. If (and only if) the user explicitly says so, run
  `scripts/sessions.sh ask-mode <sessionId> false` and retry.

### Rate limit (`429`) from auth routes

- **Symptom**: `POST /api/auth/login` or `POST /invites/:token/accept`
  returns `429 Too Many Requests`.
- **Cause**: the server runs per-IP limiters on these routes; repeated
  failed attempts from the same IP get throttled. If the deployment sits
  behind an unexpected proxy, every request can appear to come from the
  same IP (see **Rate limiting — `trust proxy`** in the auth reference).
- **Recovery**: back off for a minute; do not retry in a tight loop.
  If the limiter is collapsing legitimate traffic, check `trust proxy`
  in `server/index.ts` against the real topology.

### WebSocket stream closes without a final message

- **Symptom**: the assistant message stops streaming mid-response; no
  `stream_end` event ever arrives.
- **Cause**: the CLI subprocess crashed, the server restarted, or the
  network dropped. The client auto-reconnects, but the in-flight message
  is lost on the server.
- **Recovery**: re-send the prompt. If it recurs, capture the server logs
  (`pm2 logs agent-hub` on the deployment) and file a Backlog card tagged
  `tool-error` with the exact reproduction.
