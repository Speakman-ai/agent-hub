---
name: kanban
description: >-
  Manage project kanban board — list, create, move, and update task cards.
  TRIGGER when: user mentions "kanban", "board", "cards", "tasks", "backlog",
  "sprint", or asks to track, create, or move work items.
version: 1.2.0
keep-coding-instructions: true
---

# Kanban Board Management

You can manage the project's kanban board to track and organize tasks.
Cards move through columns (To Do → In Progress → Review → Done)
and can declare dependencies on one another via **blockers**.

> **Never paste raw `curl` without auth headers.** On JWT-enabled Hub
> deployments, unauthenticated calls return **401** and card creation
> silently fails. Use the wrappers under `scripts/` — they resolve
> `x-api-key` from `$AGENT_HUB_API_KEY` or the per-session spawn-creds
> file (`$AGENT_HUB_DATA_DIR/spawn-creds/$AGENT_HUB_SESSION_ID.token`).

Scripts live in the `agent-hub` skill tree (`scripts/`). Set `PROJECT_ID`
before running them.

## Available Actions

### List cards

```bash
scripts/kanban-list.sh
scripts/get-board-state.sh   # columns + cards + epics + blocker edges
```

For the full board (columns + cards + epics + **blocker edges**) use
`GET /board` via `scripts/get-board-state.sh` — every card in that response
is enriched with `blockers` and `blocks` arrays (see "Blockers" below).

### Create a card

```bash
scripts/kanban-create-card.sh --title "Task title" \
  --column "To Do" \
  --priority high \
  --description "Details"
# --session-id defaults to $AGENT_HUB_SESSION_ID when set
```

REST equivalent (only when you must call curl — **always** send auth):

```bash
scripts/ah-api.sh POST "/api/projects/$PROJECT_ID/board/cards" \
  -d '{"title":"Task title","columnId":"<uuid>","priority":"high"}'
```

### Move a card

```bash
scripts/kanban-move-card.sh <cardId> "In Progress"
```

### Update a card

```bash
scripts/board.sh update <cardId> '{"title":"Updated title","priority":"medium"}'
```

## Blockers — "blocked by" relationships

Cards can declare that they're blocked by another card. The relationship
is many-to-many (one card may have multiple blockers; one card may block
multiple others) and is enforced acyclic at the application layer.

### Mental model

- An edge `A blocked_by B` means **A cannot progress until B is Done**.
- "Done" is defined by the column name — any column whose name contains
  the substring "done" (case-insensitive) resolves the blocker. Renaming
  a column to "Done ✅" or "Deployed / Done" still counts.
- A blocker is **unresolved** when the blocking card is not yet in a
  Done-ish column. A card with zero unresolved blockers is "clear".

### Read blocker state from the board

`GET /api/projects/:projectId/board` returns every card with two arrays:

```jsonc
{
  "id": "card-A",
  "title": "Build feature X",
  "blockers": [
    // cards that must land before this one
    { "id": "card-B", "title": "Schema migration", "column_id": "...", "done": false },
  ],
  "blocks": [
    // cards waiting on THIS one
    { "id": "card-C", "title": "UI consuming X", "column_id": "...", "done": false },
  ],
}
```

Each link carries the blocking/blocked card's `id`, `title`, current
`column_id`, and a derived `done` boolean (true iff that card's column
name contains "done"). Clients and agents should gate decisions on
`done`, not on the column id — column ids are per-board.

A card is "cleared" to start when `blockers.every(b => b.done)` (or the
array is empty). A card landing in Done unblocks every card in its
`blocks` array — worth checking when you finish work so you can either
pick up a newly-clear card next or ping the owner of the downstream.

### Add a blocker

```bash
scripts/ah-api.sh POST "/api/projects/$PROJECT_ID/board/cards/$CARD_ID/blockers" \
  -d '{"blockedByCardId": "<other-card-id>"}'
```

- **201** with `{id, card_id, blocked_by_card_id}` on success.
- **400** `{"error": "blockedByCardId is required"}` if the body is
  missing the field, or `{"error": "A card cannot block itself"}`.
- **404** `{"error": "Card not found"}` if either card doesn't exist or
  the two cards don't share the same project board (blocker edges are
  scoped to a single board).
- **409** `{"error": "duplicate"}` if that edge already exists — safe to
  ignore; the state you wanted is already there.
- **409** `{"error": "cycle", "path": ["card-A", "card-B", ..., "card-A"]}`
  if adding the edge would close a loop. The `path` names the cycle so
  you can explain to the user which chain would conflict. Do NOT retry
  blindly — pick a different edge or delete an existing link first.

### Remove a blocker

```bash
scripts/ah-api.sh DELETE "/api/projects/$PROJECT_ID/board/cards/$CARD_ID/blockers/$BLOCKED_BY_CARD_ID"
```

- **204** on success.
- **404** `{"error": "Blocker link not found"}` if the edge isn't there —
  also safe to treat as idempotent success.

Removing a blocker is the correct action when (a) the blocking work
turned out to be unrelated, (b) the blocker was merged into the blocked
card's scope, or (c) you're breaking a cycle to add a more accurate edge.

### Enforcement model — soft, not hard

- The **move endpoint does NOT gate on blocker state.** A card with
  unresolved blockers can still be dragged to In Progress / Review. The
  UI shows a confirmation dialog; the agent has to check the arrays
  itself before moving.
- The **autonomous dispatcher silently skips** cards with unresolved
  blockers (see `hasUnresolvedBlockers` in `server/kanban-blockers.ts`).
  So for cards that run under autonomous mode, blockers effectively gate
  dispatch — but manually-picked cards do not.
- **The Done column is blocker-insensitive.** Dragging into Done (the
  user is marking work finished) never triggers the confirmation. Any
  custom column whose name still contains "Backlog" is also treated as
  blocker-insensitive for back-compat. Every other column (To Do,
  In Progress, Review, custom) is blocker-sensitive.

Treat blockers as _guidance_: if you're about to start a card and its
`blockers` contains an entry with `done: false`, stop and either (a)
resolve the blocker first, (b) delete the edge if it's stale, or (c)
surface it to the user and ask.

## Workflow

1. Check the board for "To Do" cards with no unresolved blockers
   (`blockers.every(b => b.done)`).
2. Pick the highest-priority clear card.
3. Move it to "In Progress".
4. Do the work.
5. Add a comment with your findings / PR link.
6. Move to "Review" or "Done".
7. When you land a card (move to Done), glance at its `blocks` array —
   downstream cards may now be clear. If one is, it's a natural next
   pick; if it's owned by another agent, a heads-up comment is polite.
8. If mid-work you discover a new dependency, add a blocker edge rather
   than abandoning the card — the edge captures the reason for the pause.
