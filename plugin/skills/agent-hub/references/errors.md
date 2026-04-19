# Errors — Self-Reporting & Common Failure Modes

Tool calls fail. The important thing is that when one blocks progress, you
log it in a way future Session Health tooling can mine, and you know the
two or three recovery steps that usually unstick the common failures.

Back to [SKILL.md](../SKILL.md).

## Contents

- [TOOL_ERROR self-reporting](#tool_error-self-reporting)
  - [Format](#format)
  - [When to log](#when-to-log)
  - [When to skip](#when-to-skip)
  - [Escalation](#escalation)
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
into your daily notes so patterns are minable across sessions. This is
currently a **convention** (no server-side parser) that feeds future Session
Health tooling — keep the format exact.

### Format

Single line, **pipe-delimited**, six fields:

```
TOOL_ERROR | <ISO timestamp> | <tool name> | <command/action> | <exit code or error type> | <one-line summary>
```

Example:

```
TOOL_ERROR | 2026-04-19T02:45:00Z | Bash | npm test | exit 1 | ENOENT: tsx not found in PATH
```

### When to log

- A tool call exits non-zero and you cannot route around it.
- A binary / dependency is missing or a permission is denied.
- You retry the same operation 3+ times — the pattern itself is signal.

### When to skip

- The failure is expected (e.g. `git status` shows no changes, a grep
  returns no matches).
- The tool succeeded but the result was empty.

### Escalation

If the same pattern shows up across 2+ sessions, open a Backlog card tagged
`tool-error` that quotes the structured lines, so the recurring failure
gets triaged instead of repeatedly re-logged. Use `scripts/board.sh create`
to open the card.

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
