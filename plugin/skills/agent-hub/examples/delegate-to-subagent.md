# Example: Delegate a Parallel Audit to Sub-Agents

**Scenario:** a user asks for two independent checks — one in the frontend code,
one in the backend code. You spawn both as parallel `<delegate>` sub-agent
sessions, let them finish, and synthesize their findings in your next turn.

Back to [README](README.md) · See
[`references/sessions.md#delegate--parallel-one-shot-sub-agents`](../references/sessions.md#delegate--parallel-one-shot-sub-agents).

---

## Input (user message)

> Can you check whether the chat scroll-follow regression is still a problem?
> Audit the frontend scroll hook **and** the backend stream-end event emitter
> in parallel, then summarize.

## Walk-through

### 1. Confirm the candidate sub-agents exist in this project

Every `<delegate>` target must be a sub-agent of the emitter in the same
project. Probe the agent list first.

```bash
scripts/server.sh agents \
  | python3 -c "import json,sys; [print(a['id'], '-', a['name']) for a in json.load(sys.stdin) if a.get('project_id')=='agent-hub']"
```

Expected output (abbreviated):

```
agent-hub-frontend - Agent Hub Frontend
agent-hub-backend  - Agent Hub Backend
agent-hub-lead     - Agent Hub Lead
```

### 2. Emit the `<delegate>` block as the final content of your turn

**This is chat output, not a shell command.** The server parses the fenced
block from your assistant message after the CLI process closes. Anything after
`</delegate>` is dropped — keep the block last.

````markdown
I'll fan this out to the two specialists in parallel and synthesize their
findings when they return.

<delegate>
[
  {
    "agentId": "agent-hub-frontend",
    "task": "Audit client/src/components/Chat.jsx and the useChatScroll hook for scroll-follow regressions. Is the user-scroll-up detection still accurate? Does auto-follow re-engage on new assistant messages when the user is at the bottom? Report exact file:line references and a one-paragraph verdict."
  },
  {
    "agentId": "agent-hub-backend",
    "task": "Check whether server/chat.ts still emits the legacy `stream_end` WebSocket event, or only the new `message_end`. Grep for both names, report the emit sites, and confirm whether the client hook in step 1 still needs the legacy name."
  }
]
</delegate>
````

### 3. What the server does

After your turn closes (`server/chat.ts` parses the block, `server/delegation.ts`
dispatches):

1. Inserts two rows into `delegations` with `status='pending'`.
2. Spawns two fresh CLI subprocesses **concurrently** via `Promise.all`.
3. Waits for both to close, collects `{agentId, agentName, output, error}`.
4. Injects a synthesized summary message into **your** next turn.

### 4. Expected synthesis (what the lead receives in the next turn)

```
## Delegation results (2/2 complete)

### agent-hub-frontend
<output from the frontend sub-agent — file:line findings, verdict>

### agent-hub-backend
<output from the backend sub-agent — grep hits, verdict>
```

If a sub-agent errored, that slot contains `error: <stderr>` instead of
`output`. The lead still gets a deterministic message — a failed sub-agent
never throws up the lead's next turn.

### 5. Post-synthesis — update the user and the board

After reading both outputs in your next turn:

```bash
# Drop a comment on the active card if you're triaging under one
PROJECT_ID=agent-hub scripts/board.sh comment "<cardId>" '{
  "author": "agent-hub-lead",
  "content": "Delegation complete. Frontend: hook still correct. Backend: legacy `stream_end` removed in PR #412 — safe to delete the compat branch client-side."
}'
```

Expected output (abbreviated):

```json
{"id":"c1a2…","card_id":"<cardId>","author":"agent-hub-lead","created_at":"2026-04-19T05:46:…"}
```

---

## Copy-paste checklist

- [x] Confirm sub-agent IDs via `scripts/server.sh agents`
- [x] Emit `<delegate>` block as the **last** content in the turn
- [x] Keep N ≤ 4 (every delegate is a real CLI subprocess)
- [x] Read synthesis in next turn, then comment / move cards

## Gotchas

- **One fenced block per turn.** Multiple `<delegate>` blocks are ignored after
  the first.
- **Array payload only.** `<delegate>` requires a JSON array. For a single
  target where you want ownership transfer, use `<handoff>` instead.
- **No chat content after `</delegate>`.** It's logged and dropped. Put any
  narration for the user *before* the block.
- **Don't confuse with `<handoff>`.** `<delegate>` collects output and resumes
  you; `<handoff>` ends your turn and transfers ownership.
