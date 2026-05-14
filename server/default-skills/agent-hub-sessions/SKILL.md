---
name: agent-hub-sessions
description: >-
  Agent Hub session lifecycle and multi-agent coordination — message history,
  per-user session ownership, ask mode (read-only / plan mode), the ReAct
  loop, and the three fenced coordination blocks: <delegate> for parallel
  sub-agent dispatch, <handoff> for ownership transfer to one specialist,
  and <agenthub:close-card> for auto-closing duplicate / already-done cards
  linked to your session. TRIGGER only on Agent Hub session signals: the
  fenced blocks themselves (<delegate>, <handoff>, <agenthub:close-card>);
  the words "ask mode", "plan mode", "read-only session", "delegation",
  "handoff"; the wrapper scripts/sessions.sh; or URLs under
  /api/agents/<id>/sessions or /api/sessions/<id>. DO NOT TRIGGER on
  generic chat session vocabulary (HTTP sessions, login sessions, terminal
  sessions, browser sessions, REPL sessions, support tickets) — only the
  Agent Hub message/session model. DO NOT TRIGGER on the Claude Code CLI's
  internal sub-agent system, which is separate.
category: platform
version: 1.0.0
keep-coding-instructions: true
---

# Agent Hub — Sessions, Ask Mode, Delegation

Sessions hold message history; `messages` stores the per-turn log.
Coordination with sub-agents lives here too. Full reference:
**[references/sessions.md](references/sessions.md)**. Scripts live in the
shared core tree (`agent-hub/scripts/`).

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

## Coordination blocks (fenced JSON, end-of-turn)

Three blocks the server parses after your turn closes. The native Claude
Code `Skill` tool is disabled host-side (`--disallowed-tools Skill`); load
skills via `<agenthub:skill>` instead.

### `<delegate>` — parallel one-shot sub-agents

Fan out specialist audits in parallel. Each entry spawns a sub-agent that
returns a single message; results are joined back into your next turn. Use
when work is **embarrassingly parallel** and the sub-agents don't need to
talk to each other.

### `<handoff>` — ownership transfer to one specialist

Transfers the session and current task to another agent. Used when one
agent needs to take over (e.g. lead → backend specialist for the
implementation phase). Tracked in the `handoffs` table with `pending →
delivered → failed` states. In `workflow`-mode projects the target session
defaults to **no per-session git worktree** and PR-flow gating differs.

### `<agenthub:close-card>` — auto-close a duplicate / already-done card

Marks a kanban card linked to your session as Done with an audit comment.
Rely on **CI and pre-commit hooks** for verification — the close block is
bookkeeping, not validation. See the reference for shape, lifecycle, and
the Done-state contract this composes with.

## Project `mode` and worktree defaults

Projects carry `mode = dev | workflow`. In **workflow** mode, new sessions
(including `<handoff>` targets) default to no per-session worktree,
automated GitHub reviewer dispatch is off, and session-owned PR flows are
gated. Check `mode` before assuming worktree isolation.

## See also

- Core skill `agent-hub` — env contract, auth, error self-reporting.
- `references/sessions.md` — full session schema, block shapes, lifecycle.
