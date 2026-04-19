# Ask Mode — Read-Only Agent Sessions

Sessions carry an `ask_mode` flag (`sessions.ask_mode` column, toggled via
`PUT /api/sessions/:id/ask-mode` with `{enabled: boolean}`). When
`ask_mode=1`, the Claude CLI is invoked with `--permission-mode plan`
instead of `bypassPermissions`.

Use `scripts/sessions.sh ask-mode <sessionId> true|false` from the command
line. Never call the endpoint inline.

## What changes in ask mode (plan mode)

- **Allowed**: reading files, grep/glob, web fetch, API queries, analysis,
  planning, writing proposed changes into the chat as prose/diffs.
- **Not allowed without explicit approval**: executing shell commands that
  mutate state, editing/creating files on disk, opening PRs, spawning
  sub-agents, running deploys.

Use ask mode for triage, code review, architecture discussions, or any time
the user wants recommendations before any write lands. The session is
effectively **read-only** (analysis and planning only).

## Detecting ask_mode from inside a session

- Query the session row: `GET /api/sessions/:id` → `ask_mode`
- Infer from behavior: file writes fail with a plan-mode prompt.

Do not assume you can write just because the tool exists. If you're in plan
mode and need to mutate, surface a clear proposal and wait for the user to
flip the mode.

## Flipping ask mode programmatically

Only do this at the user's explicit request, because it changes the
contract of the in-flight session:

```bash
scripts/sessions.sh ask-mode <sessionId> true    # enter plan mode
scripts/sessions.sh ask-mode <sessionId> false   # resume normal permissions
```
