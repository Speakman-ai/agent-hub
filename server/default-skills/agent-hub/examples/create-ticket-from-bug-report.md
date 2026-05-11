# Example: Create a Ticket from a Bug Report

**Scenario:** a user pastes a bug report into chat and asks you to triage it
into a kanban card. You should search the wiki and existing board to avoid a
duplicate, then create a card with a concise title, acceptance criteria, and
session linkage.

Back to [README](README.md) · See [`references/kanban.md`](../references/kanban.md).

---

## Input (user message)

> Hey — users on Windows are reporting `scripts/ah-api.mjs` is a silent no-op.
> Looks like a path-comparison bug in the direct-invocation check. Please file
> a ticket.

## Walk-through

### 1. Check the wiki for prior art

```bash
PROJECT_ID=agent-hub scripts/wiki-search.sh "windows path ah-api"
```

Expected output (empty result → no wiki coverage yet, safe to proceed):

```json
{"pages": []}
```

### 2. Check the board for a duplicate card

```bash
PROJECT_ID=agent-hub scripts/kanban-list.sh --column "To Do" \
  | python3 -c "import json,sys; [print(c['id'], '-', c['title']) for c in json.load(sys.stdin) if 'windows' in c['title'].lower()]"
```

Expected output (no matches):

```
```

### 3. Create the card

Use a **concise title** (under 60 chars) and put acceptance criteria in the
description as a bulleted checklist. Pass `--session-id "$AGENT_HUB_SESSION_ID"`
so the card is linked to this session and the sidebar auto-renames.

```bash
PROJECT_ID=agent-hub scripts/kanban-create-card.sh \
  --title "Windows: ah-api.mjs direct-invoke detection silently no-ops" \
  --column "To Do" \
  --priority high \
  --labels bug,windows,cli \
  --session-id "$AGENT_HUB_SESSION_ID" \
  --description "$(cat <<'MD'
## Problem
`new URL('file://' + process.argv[1])` compares `import.meta.url` (forward slashes)
against a Windows path (backslashes), so the direct-invocation branch never fires
on Windows. Running `node scripts/ah-api.mjs …` is a silent no-op.

## Acceptance Criteria
- [ ] Direct-invocation check uses `pathToFileURL(process.argv[1]).href`
- [ ] Verified manually on Windows 11 / PowerShell and WSL
- [ ] Unit test covering the path-normalization edge case
- [ ] No regression on macOS / Linux runs
MD
)"
```

Expected output (abbreviated — the card JSON with a fresh `id`):

```json
{
  "id": "7b1e4a2c-…",
  "title": "Windows: ah-api.mjs direct-invoke detection silently no-ops",
  "column_id": "4d0…-todo-…",
  "priority": "high",
  "labels": "bug,windows,cli",
  "session_id": "45fb2a2b-…",
  "created_at": "2026-04-19T05:40:12.000Z",
  "position": 0
}
```

### 4. (Optional) Confirm the card is linked to this session

```bash
PROJECT_ID=agent-hub scripts/board.sh list \
  | python3 -c "import json,sys,os; [print(c['id']) for c in json.load(sys.stdin) if c.get('session_id')==os.environ['AGENT_HUB_SESSION_ID']]"
```

Expected output:

```
7b1e4a2c-…
```

The sidebar title in the web UI updates to the card title within ~1s via the
`kanban_update` WebSocket event.

---

## Copy-paste checklist

- [x] Wiki search for duplicates → empty
- [x] Board scan for duplicates → none
- [x] `kanban-create-card.sh` with `--session-id`, priority, labels, AC checklist
- [x] Verified session linkage

## Gotchas

- **Don't** pass `--epic-id` unless you know the epic UUID. The create endpoint
  doesn't accept it; the wrapper chains a second call to `/cards/:id/epic`.
- **Don't** hard-code column UUIDs. They're per-project and rotate when a board
  is recreated. Always use `--column "To Do"` and let the wrapper resolve.
- If the title contains quotes or newlines, keep using `--description "$(cat <<'MD' … MD)"`
  so bash doesn't mangle it.
