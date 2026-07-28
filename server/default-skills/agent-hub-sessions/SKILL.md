---
name: agent-hub-sessions
description: >-
  Agent Hub session lifecycle and multi-agent coordination — message history,
  per-user session ownership, ask mode (read-only / plan mode), the ReAct
  loop, and the <agenthub:close-card> block for auto-closing duplicate /
  already-done cards linked to your session. TRIGGER only on Agent Hub
  session signals: the <agenthub:close-card> block; the words "ask mode",
  "plan mode", "read-only session", "session ownership", "forward session";
  the wrapper scripts/sessions.sh; or URLs under
  /api/agents/<id>/sessions or /api/sessions/<id>. DO NOT TRIGGER on
  generic chat session vocabulary (HTTP sessions, login sessions, terminal
  sessions, browser sessions, REPL sessions, support tickets) — only the
  Agent Hub message/session model. DO NOT TRIGGER on the Claude Code CLI's
  internal sub-agent system, which is separate.
category: platform
version: 2.0.0
keep-coding-instructions: true
---

# Agent Hub — Sessions & Ask Mode

Sessions hold message history; `messages` stores the per-turn log. Full
reference: **[references/sessions.md](references/sessions.md)**. Scripts live
in the shared core tree (`agent-hub/scripts/`).

```bash
scripts/sessions.sh list <agentId>           # sessions for an agent
scripts/sessions.sh messages <sessionId>     # full message history
scripts/sessions.sh ask-mode <sessionId> true|false
```

## Ask mode (read-only / plan mode)

A session with `ask_mode = 1` runs in **plan mode**: the engine is launched
with `--permission-mode plan`, write tools (Edit / Write / Bash mutating
commands) are blocked, and the agent's job is analysis + planning. Toggle
with `scripts/sessions.sh ask-mode <sessionId> true`. Useful for review,
audit, and exploratory work.

## Agent Hub has no app-level sub-agent dispatch

Agents are peers. There is no block you can emit to spawn a sub-agent or
transfer ownership of a session — that dispatch system was removed. To pull
another agent in, use plain chat, kanban assignment, the Forward Session
flow, a multi-agent session, or a conference room. The CLI engines run their
own internal sub-agent orchestration, which is separate and unaffected.

## `<agenthub:close-card>` — auto-close a duplicate / already-done card

Marks a kanban card linked to your session as Done with an audit comment.
The server parses it from your final assistant message after the CLI process
closes, so it is terminal in the turn. Rely on **CI and pre-commit hooks**
for verification — the close block is bookkeeping, not validation. The
native Claude Code `Skill` tool is disabled host-side
(`--disallowed-tools Skill`); load skills via `<agenthub:skill>` instead.
See the reference for shape, lifecycle, and the Done-state contract this
composes with.

## Project `mode` and worktree defaults

Projects carry `mode = dev | workflow`. In **workflow** mode, new sessions
default to no per-session worktree, automated GitHub reviewer dispatch is
off, and session-owned PR flows are gated. Check `mode` before assuming
worktree isolation.

## See also

- Core skill `agent-hub` — env contract, auth, error self-reporting.
- `references/sessions.md` — full session schema, block shapes, lifecycle.
