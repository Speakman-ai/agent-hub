# Agent Coordination — `<delegate>`, `<handoff>`, `<agenthub:close-card>`

Lead agents coordinate with their sub-agents by emitting **fenced JSON blocks**
in chat output. The server parses these from the final assistant message
after the CLI process closes — they are **terminal in the turn** (anything
after the closing tag is dropped). Parsing lives in `server/chat.ts` and
dispatch in `server/delegation.ts` + `server/handoff.ts`.

All targets must be listed as sub-agents of the emitter (same project).

## `<delegate>` — parallel one-shot sub-agents

Spawn one or more sub-agents in parallel as fresh CLI processes. Each receives
a self-contained `task` string; their outputs are collected and injected
into the lead's next turn as a synthesized summary message. The lead stays
running.

```
<delegate>
[
  {"agentId": "hub-frontend", "task": "Audit client/src/components/Chat.jsx for scroll-follow regressions."},
  {"agentId": "hub-backend",  "task": "Check if server/chat.ts still emits the old `stream_end` event."}
]
</delegate>
```

- **Payload**: JSON array of `{agentId, task}` objects. Both fields required,
  both strings.
- **Parallelism**: All tasks spawn concurrently via `Promise.all`. No hard
  cap, but keep N small (≤ 4) — every spawn is a real CLI subprocess with
  its own context.
- **Return shape**: A synthesis message containing per-task
  `{agentId, agentName, output, error}`. Failed sub-agents surface as
  `error`, not as an exception — the lead always gets something back.
- **When to use**: short parallel side-quests whose results you will read
  and synthesize. Not for multi-turn ownership — use `<handoff>` for that.

## `<handoff>` — ownership transfer to one specialist

End your turn and hand ownership of the conversation to a single sub-agent.
A **new session** is created for the target with your transcript (tail of
last 50 turns) plus the `note` pre-injected into their enriched system
prompt via `buildHandoffPromptSection`. The user continues the conversation
with the target; you do not see their reply.

```
<handoff>
{"toAgent": "hub-backend", "note": "Plan done — failing test is server/chat.test.ts:142, fix likely at server/chat.ts:754 (isAskMode branch). Linked card: 36d919a9. Please implement + PR."}
</handoff>
```

- **Payload**: single JSON object with required string fields `toAgent` and
  `note`. Array payloads are rejected; only one target per handoff.
- **Lifecycle** (rows in the `handoffs` table): `pending` (created) →
  `delivered` (target session spawned and primed) → `failed` (validation
  error, target not in project, or spawn failure).
- **Terminal**: anything emitted after `</handoff>` is logged and dropped.
- **When to use**: the specialist needs multiple turns, will likely commit /
  open a PR, or needs the full transcript as background. Prefer `<handoff>`
  over `<delegate>` for anything beyond a short side-quest.

## `<agenthub:close-card>` — auto-close duplicate / already-done cards

If you pick up a kanban card and discover the work is redundant (duplicates
an earlier card, or already shipped), don't leave the card parked. End your
turn with:

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

## Choosing between them

| Scenario                                                       | Use            |
| -------------------------------------------------------------- | -------------- |
| Two or three short audits you'll synthesize yourself           | `<delegate>`   |
| Specialist needs to commit / PR / take multiple turns          | `<handoff>`    |
| Discovered the card you're on is already shipped / a dupe      | `<agenthub:close-card>` |
