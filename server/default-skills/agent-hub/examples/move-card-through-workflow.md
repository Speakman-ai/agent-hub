# Example: Walk a Card Through the Workflow

**Scenario:** a new feature card starts in **Backlog**, you pick it up,
implement it, open a PR, and the human merges. Here's the exact sequence of
`scripts/` calls that takes a card through every column state.

Back to [README](README.md) · See [`references/kanban.md`](../references/kanban.md).

---

## Input (user message)

> Pick up the "Add examples/ directory" card in Backlog, do the work, and keep
> the board in sync as you go.

## Walk-through

### 1. Find the card (resolve name → id)

```bash
PROJECT_ID=agent-hub scripts/kanban-list.sh --column Backlog \
  | python3 -c "import json,sys; [print(c['id'], '-', c['title']) for c in json.load(sys.stdin) if 'examples' in c['title'].lower()]"
```

Expected output:

```
a3f8c1e9-… - Add examples/ directory with concrete input->output pairs
```

Capture the id:

```bash
CARD_ID="a3f8c1e9-…"
```

### 2. Move **Backlog → To Do** and claim it

The session you're in isn't linked to the card yet — patch `session_id` so
the sidebar renames and `<agenthub:close-card>` becomes available.

```bash
PROJECT_ID=agent-hub scripts/kanban-move-card.sh "$CARD_ID" "To Do"
PROJECT_ID=agent-hub scripts/board.sh update "$CARD_ID" "{
  \"session_id\": \"$AGENT_HUB_SESSION_ID\",
  \"assignee\": \"agent-hub-backend\"
}"
```

Expected output (from the `update` — the moved-card JSON is returned):

```json
{
  "id": "a3f8c1e9-…",
  "title": "Add examples/ directory…",
  "column_id": "<to-do-uuid>",
  "session_id": "45fb2a2b-…",
  "assignee": "agent-hub-backend",
  "updated_at": "2026-04-19T05:32:07.000Z"
}
```

### 3. Move **To Do → In Progress** when you start coding

```bash
PROJECT_ID=agent-hub scripts/kanban-move-card.sh "$CARD_ID" "In Progress"
```

Expected output:

```json
{"id":"a3f8c1e9-…","column_id":"<in-progress-uuid>","updated_at":"2026-04-19T05:32:45.000Z", …}
```

### 4. Comment progress / blockers as you work

```bash
PROJECT_ID=agent-hub scripts/board.sh comment "$CARD_ID" '{
  "author": "agent-hub-backend",
  "content": "Drafted the five example files under plugin/skills/agent-hub/examples/. Running through each to confirm the copy-paste snippets work against a live instance."
}'
```

Expected output:

```json
{"id":"c4a1…","card_id":"a3f8c1e9-…","author":"agent-hub-backend","created_at":"2026-04-19T05:42:11.000Z"}
```

### 5. Open a PR → move **In Progress → Review**

If the session is linked to the card, the server auto-pushes and opens the PR
at session end. If you're opening the PR manually, record it on the card:

```bash
PROJECT_ID=agent-hub scripts/kanban-move-card.sh "$CARD_ID" "Review"
PROJECT_ID=agent-hub scripts/board.sh update "$CARD_ID" '{
  "pr_url": "https://github.com/Speakman-ai/agent-hub/pull/441"
}'
```

Expected output:

```json
{
  "id": "a3f8c1e9-…",
  "column_id": "<review-uuid>",
  "pr_url": "https://github.com/Speakman-ai/agent-hub/pull/441",
  "updated_at": "2026-04-19T05:58:02.000Z"
}
```

### 6. Human merges → move **Review → Done**

Agents **never merge their own PRs** — the human does. Once merged, move the
card to Done:

```bash
PROJECT_ID=agent-hub scripts/kanban-move-card.sh "$CARD_ID" "Done"
PROJECT_ID=agent-hub scripts/board.sh comment "$CARD_ID" '{
  "author": "agent-hub-backend",
  "content": "Merged in PR #441. Closing."
}'
```

Expected output (final move):

```json
{"id":"a3f8c1e9-…","column_id":"<done-uuid>","updated_at":"2026-04-19T06:20:13.000Z", …}
```

### 7. Or — discovered it was a duplicate mid-stream

If you realize the work is already done or duplicates another card, don't
just park the card — end your turn with the close-card block instead:

````markdown
<agenthub:close-card>
{"reason": "duplicate", "note": "Covered by card 5c8f2a — see PR #313.", "duplicateOfCardId": "5c8f2a-…"}
</agenthub:close-card>
````

The server moves the **session-linked** card to Done and appends an
explanatory comment. Requires step 2 (`session_id` patched onto the card).

---

## Copy-paste checklist

- [x] Resolve card id via `kanban-list.sh --column Backlog`
- [x] Patch `session_id` so the sidebar renames & close-card becomes available
- [x] Move Backlog → To Do → In Progress → Review → Done in order
- [x] Add a `pr_url` on the **Review** move
- [x] Comment at each inflection point (start, PR, merge)
- [x] Or short-circuit with `<agenthub:close-card>` for dupes / already-done

## Gotchas

- **Column names are case-insensitive** (`"in progress"`, `"In Progress"`, or
  `"IN PROGRESS"` all resolve). But they must be one of
  `Backlog | To Do | In Progress | Review | Done` for the standard board.
- **`board.sh update` is a full PUT.** Only the fields you pass are changed —
  missing fields are left alone.
- **Don't hard-code column UUIDs.** Use `kanban-move-card.sh <id> "<name>"` or
  `resolve-column-id.sh "<name>"` on every run — UUIDs rotate per-project.
- **Moving to Done does NOT close the PR.** That's GitHub's job. If you need
  to abandon the work, also close the PR via `gh pr close` (if the human has
  OK'd it).
- **`<agenthub:close-card>` requires `session_id` on the card.** If step 2 was
  skipped, the close-card block is a no-op.
