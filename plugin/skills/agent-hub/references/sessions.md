# Sessions & Messages

You're running inside a chat session. The `sessions` table tracks the
session; `messages` stores the per-turn chat log. You can query other
sessions too — useful for session handoffs, triage, and cross-session
analysis.

## Listing sessions

```bash
scripts/sessions.sh list <agentId>      # sessions for a given agent
scripts/sessions.sh messages <sessionId>  # full message history
```

## Session row

Notable columns: `id`, `agent_id`, `engine` (`claude` | `cursor`), `model`,
`ask_mode` (0/1 — see `references/ask-mode.md`), `created_at`,
`updated_at`, `title`, `last_message_at`.

## Ask mode

`PUT /api/sessions/:id/ask-mode` with `{enabled: boolean}` flips the
session into read-only / plan mode. Use the wrapper:

```bash
scripts/sessions.sh ask-mode <sessionId> true
scripts/sessions.sh ask-mode <sessionId> false
```

See `references/ask-mode.md` for what changes and how to detect it.

## Message row

`messages` holds `id`, `session_id`, `role` (`user` | `assistant` |
`system`), `content`, `tool_calls` (JSON blob when applicable), and
timestamps. Messages are stored in order; there's no separate turn index.

## Handing off to another agent

If you need a fresh agent to continue the work, emit a `<handoff>` block
(see `references/coordination.md`). The server creates a new session for
the target and copies the last 50 turns into the target's system prompt.
