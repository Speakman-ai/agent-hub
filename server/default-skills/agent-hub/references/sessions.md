# Sessions — Messages, Ask Mode & Delegation

You're running inside a session. The `sessions` table tracks the
session; `messages` stores the per-turn message log. You can query other
sessions too — useful for handoffs, triage, and cross-session analysis.
Coordination with sub-agents also happens through the session layer, via
three fenced JSON blocks the server parses after your turn closes.

Back to [SKILL.md](../SKILL.md).

## Contents

- [Listing sessions & messages](#listing-sessions--messages)
- [Session row](#session-row)
- [Message row](#message-row)
- [Ask mode — read-only / plan-mode sessions](#ask-mode--read-only--plan-mode-sessions)
  - [What changes in ask mode](#what-changes-in-ask-mode)
  - [Detecting ask_mode from inside a session](#detecting-ask_mode-from-inside-a-session)
  - [Flipping ask mode programmatically](#flipping-ask-mode-programmatically)
- [Delegation to sub-agents](#delegation-to-sub-agents)
  - [`<delegate>` — parallel one-shot sub-agents](#delegate--parallel-one-shot-sub-agents)
  - [`<handoff>` — ownership transfer to one specialist](#handoff--ownership-transfer-to-one-specialist)
  - [`<agenthub:close-card>` — auto-close duplicate / already-done cards](#agenthubclose-card--auto-close-duplicate--already-done-cards)
  - [Choosing between them](#choosing-between-them)

## Listing sessions & messages

```bash
scripts/sessions.sh list <agentId>           # sessions for a given agent
scripts/sessions.sh messages <sessionId>     # full message history
```

## Session row

Notable columns: `id`, `agent_id`, `engine` (`claude-code` | `cursor-agent` | `gemini-cli` | `codex-cli`), `model`,
`ask_mode` (0/1 — see below), `created_at`, `updated_at`, `title`,
`last_message_at`.

## Message row

`messages` holds `id`, `session_id`, `role` (`user` | `assistant` |
`system`), `content`, `tool_calls` (JSON blob when applicable), and
timestamps. Messages are stored in order; there's no separate turn index.

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

## Delegation to sub-agents

Lead agents coordinate with sub-agents by emitting **fenced JSON blocks**
in chat output. The server parses these from the final assistant message
after the CLI process closes — they are **terminal in the turn** (anything
after the closing tag is dropped). Parsing lives in `server/chat.ts` and
dispatch in `server/delegation.ts` + `server/handoff.ts`. All targets must
be listed as sub-agents of the emitter (same project).

### `<delegate>` — parallel one-shot sub-agents

Spawn one or more sub-agents in parallel as fresh CLI processes. Each
receives a self-contained `task` string; their outputs are collected and
injected into the lead's next turn as a synthesized summary message. The
lead stays running.

```
<delegate>
[
  {"agentId": "hub-frontend", "task": "Audit client/src/components/Chat.jsx for scroll-follow regressions."},
  {"agentId": "hub-backend",  "task": "Check if server/chat.ts still emits the old `stream_end` event."}
]
</delegate>
```

- **Payload**: JSON array of `{agentId, task}` objects. Both fields
  required, both strings.
- **Parallelism**: all tasks spawn concurrently via `Promise.all`. No hard
  cap, but keep N small (≤ 4) — every spawn is a real CLI subprocess with
  its own context.
- **Return shape**: a synthesis message containing per-task
  `{agentId, agentName, output, error}`. Failed sub-agents surface as
  `error`, not as an exception — the lead always gets something back.
- **When to use**: short parallel side-quests whose results you will read
  and synthesize. Not for multi-turn ownership — use `<handoff>` for
  that.

### `<handoff>` — ownership transfer to one specialist

End your turn and hand ownership of the conversation to a single
sub-agent. A **new session** is created for the target with your
transcript (capped — see below) plus the `note` pre-injected into
their enriched system prompt via `buildHandoffPromptSection`. The user
continues the conversation with the target; you do not see their reply.

Transcript truncation is layered and tuned for cost (see the constants
at the top of `server/handoff.ts` — these are the single tuning surface
for handoff prepend cost):

- `HANDOFF_TRANSCRIPT_MAX_TURNS = 10` — tail-of-N turns are kept; older
  turns are dropped entirely. (Lowered from 50 in the April 2026
  cost audit; tail-10 preserved the signal at ~1/5 the token cost.)
- `HANDOFF_TRANSCRIPT_MAX_CHARS_PER_MESSAGE = 2000` — oversize messages
  are **middle-truncated** with a `_…(truncated N chars)…_` marker so
  both opening framing and closing conclusions survive (~1000 chars
  head + 1000 chars tail).
- `HANDOFF_TRANSCRIPT_MAX_TOTAL_CHARS = 20000` — if the joined body
  still exceeds the budget after per-message caps, whole turns are
  dropped from the head (oldest first) and the `last X of Y turns`
  label in the rendered section reflects the surviving count.

All three constants are overridable per-call via optional
`maxTurns` / `maxCharsPerMessage` / `maxTotalChars` fields on
`BuildHandoffContextArgs`, but in production the defaults apply.

```
<handoff>
{"toAgent": "hub-backend", "note": "Plan done — failing test is server/chat.test.ts:142, fix likely at server/chat.ts:754 (isAskMode branch). Linked card: 36d919a9. Please implement + PR."}
</handoff>
```

- **Payload**: single JSON object with required string fields `toAgent`
  and `note`. Array payloads are rejected; only one target per handoff.
- **Lifecycle** (rows in the `handoffs` table): `pending` (created) →
  `delivered` (target session spawned and primed) → `failed` (validation
  error, target not in project, or spawn failure).
- **Terminal**: anything emitted after `</handoff>` is logged and
  dropped.
- **When to use**: the specialist needs multiple turns, will likely
  commit / open a PR, or needs the full transcript as background. Prefer
  `<handoff>` over `<delegate>` for anything beyond a short side-quest.
- **Kanban card forwarding**: if your session owns a kanban card (i.e.
  the card's `session_id` points at you), `<handoff>` re-points the
  card to the **target** session and updates the assignee to the target
  agent. That keeps `<agenthub:close-card>`, auto-PR linkage, and the
  sidebar title working after the transfer. The target's first-turn
  prompt gets a `## Forwarded Context` block naming the card + (if the
  epic is autonomous) a reminder to commit + push rather than pause for
  human review. `handoff_start` broadcasts carry `cardId`, `cardTitle`,
  `epicId`, and `epicAutonomous` for UI / dispatch observers.

### `<agenthub:close-card>` — auto-close duplicate / already-done cards

If you pick up a kanban card and discover the work is redundant
(duplicates an earlier card, or already shipped), don't leave the card
parked. End your turn with:

```
<agenthub:close-card>
{"reason": "duplicate", "note": "Covered by card 5c8f2a — see PR #313.", "duplicateOfCardId": "5c8f2a..."}
</agenthub:close-card>
```

- **Fields**: `reason` ∈ {`"duplicate"`, `"already-done"`} (required),
  `note` (required, non-empty, one-line shown in the auto-close comment),
  `duplicateOfCardId` (optional canonical card id).
- **Server behavior**: finds the card linked to the current session via
  `kanban_cards.session_id`, moves it to the Done column, and appends an
  explanatory comment referencing this session. Best-effort — if there's
  no linked card or Done column, the chat flow is unaffected.
- **Requires**: the session must be linked to a card (it is whenever the
  sidebar was auto-renamed to the card title, i.e. when the card was
  created with `session_id: $AGENT_HUB_SESSION_ID`).

### Choosing between them

| Scenario                                                       | Use                     |
| -------------------------------------------------------------- | ----------------------- |
| Two or three short audits you'll synthesize yourself           | `<delegate>`            |
| Specialist needs to commit / PR / take multiple turns          | `<handoff>`             |
| Discovered the card you're on is already shipped / a dupe      | `<agenthub:close-card>` |
