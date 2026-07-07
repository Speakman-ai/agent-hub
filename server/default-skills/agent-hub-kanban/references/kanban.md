# Kanban — Cards, Columns, Comments, Epics

Every project has a board. Default columns (by name; IDs are per-project):
**To Do → In Progress → Done**. Move your card to In Progress when you
start; do **not** move it to Done yourself — Done means merged, and the
platform closes the card automatically when the push/merge lands (a
premature Done move is rejected with `409 premature_done_move`). Always use
`scripts/board.sh` / `scripts/epics.sh` — never inline curl — so auth and
`PROJECT_ID` are handled uniformly.

Back to [SKILL.md](../SKILL.md).

**Endpoint contracts:** <https://speakman-ai.github.io/agent-hub/#tag/Board>
(request/response shapes for every kanban / epic / blocker endpoint). This
page is the _how_.

## Board shape

```bash
scripts/board.sh get     # full board: columns[], cards[], cardTemplates[], plus metadata
scripts/board.sh list    # flat list of cards
```

`cardTemplates[]` holds reusable create defaults: `id`, `name`, `title`,
`description`, `priority`, `labels`, `epicId`, `updatedAt`. Manage them with
`scripts/kanban-card-templates.sh list|get` or the REST CRUD under
`/board/card-templates`. Apply on create with
`kanban-create-card.sh --template-id <uuid>`.

Cards carry: `id`, `column_id`, `title`, `description`, `priority`
(`urgent|high|medium|low`), `assignee`, `labels` (comma-separated string),
`session_id`, `epic_id`, `pr_url`, `review_status`, `github_issue_url`,
`position`, timestamps.

## Create a card

When the card belongs to your current work, link it to your session so the
sidebar auto-renames to the card title and `<agenthub:close-card>` becomes
available. You do not need to remember the JSON field every time:

- **`scripts/kanban-create-card.sh`** defaults `--session-id` to
  `$AGENT_HUB_SESSION_ID` when omitted and sends `X-Agent-Hub-Session-Id` on
  the create POST (body `session_id` is also set when defaulted).
- **`scripts/board.sh create`** sends `X-Agent-Hub-Session-Id` when
  `$AGENT_HUB_SESSION_ID` is set and the JSON body omits `sessionId`.
- **`POST /board/cards`** auto-stamps `session_id` from that header, or from
  a per-session spawn-creds API key (`spawn:<sessionId>`), when the body
  omits `sessionId`. Pass `"sessionId": null` to opt out (intake / bug-report
  filing). Intake-role sessions are still stripped server-side.

Explicit body `session_id` remains supported and takes precedence over the
header / spawn key.

**Do NOT self-stamp `assignee` on create.** Leave it `null` (omit the
field) and let one of the two legitimate auto-assign paths write the
correct display name:

- `POST /board/cards/:cardId/assign` — used by the UI's Assignee
  dropdown; writes `agent.name`.
- `runAutonomousLoop` (autonomous dispatch) — only picks up cards
  where `assignee IS NULL OR assignee = ''`; writes `agent.name`.

Pre-stamping `assignee` reserves the card out of the autonomous pool,
which is almost certainly not what you want for a card you just filed.
The server now normalizes any value matching a known `agent.id` →
`agent.name` on write (so a stray `"assignee": "agent-hub"` becomes
`"Hub Lead Dev"`), but it cannot reverse the pickup-blocking side
effect — leave the field empty and let the dispatcher take over.

```bash
scripts/board.sh create '{
  "title": "Short descriptive title",
  "description": "Details about the task",
  "columnId": "<column-uuid>",
  "priority": "high",
  "labels": "bug,backend",
  "session_id": "'"$AGENT_HUB_SESSION_ID"'"
}'
```

## Move / update / comment

```bash
scripts/board.sh move    <cardId> <targetColumnId>
scripts/board.sh update  <cardId> '{"priority":"medium","pr_url":"https://..."}'
scripts/board.sh comment <cardId> '{"author":"your-agent-name","content":"PR #42 open"}'
```

## Epics

Cards can be grouped into epics. Epics with `autonomous: true` can drive
automated task dispatch.

```bash
scripts/epics.sh list
scripts/epics.sh create '{"name":"Skills Overhaul","description":"…","color":"#3B82F6"}'
scripts/epics.sh link   <cardId> <epicId>
```

## Blockers — "blocked by" relationships

Cards can declare that they're blocked by another card via
`kanban_card_blockers`. The relationship is many-to-many (one card may
have multiple blockers; one card may block multiple others) and is
enforced acyclic at the application layer (BFS cycle detection in
`server/kanban-blockers.ts`).

### Mental model

- An edge `A blocked_by B` means **A cannot progress until B is Done**.
- "Done" is defined by the column name — any column whose name contains
  the substring "done" (case-insensitive) resolves the blocker. Renaming
  a column to "Done ✅" or "Deployed / Done" still counts.
- A blocker is **unresolved** when the blocking card is not yet in a
  Done-ish column. A card with zero unresolved blockers is "clear".

### Read blocker state from the board

`scripts/board.sh get` (`GET /api/projects/:projectId/board`) returns every
card with two arrays:

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
name contains "done"). Gate decisions on `done`, not on the column id —
column ids are per-board.

A card is "cleared" to start when `blockers.every(b => b.done)` (or the
array is empty). A card landing in Done unblocks every card in its
`blocks` array — worth checking when you finish work so you can pick up a
newly-clear downstream card next or ping its owner.

### Add a blocker

```bash
scripts/ah-api.sh POST "/api/projects/$PROJECT_ID/board/cards/$CARD_ID/blockers" \
  -d '{"blockedByCardId": "<other-card-id>"}'
```

- **201** with `{id, card_id, blocked_by_card_id}` on success.
- **400** `{"error": "blockedByCardId is required"}` if the field is
  missing, or `{"error": "A card cannot block itself"}`.
- **404** `{"error": "Card not found"}` if either card doesn't exist or
  the two cards don't share the same project board (blocker edges are
  scoped to a single board).
- **409** `{"error": "duplicate"}` if that edge already exists — safe to
  ignore; the state you wanted is already there.
- **409** `{"error": "cycle", "path": ["card-A", "card-B", ..., "card-A"]}`
  if adding the edge would close a loop. The `path` names the cycle so
  you can explain which chain would conflict. Do NOT retry blindly — pick
  a different edge or delete an existing link first.

### Remove a blocker

```bash
scripts/ah-api.sh DELETE "/api/projects/$PROJECT_ID/board/cards/$CARD_ID/blockers/$BLOCKED_BY_CARD_ID"
```

- **204** on success.
- **404** `{"error": "Blocker link not found"}` if the edge isn't there —
  also safe to treat as idempotent success.

### Enforcement model — soft, not hard

- The **move endpoint does not gate on blocker state.** A card with
  unresolved blockers can still be dragged to In Progress / Review. The
  UI shows a confirmation dialog; the agent must check the arrays itself
  before moving.
- The **autonomous dispatcher silently skips** cards with unresolved
  blockers (see `hasUnresolvedBlockers` in `server/kanban-blockers.ts`).
  So for autonomous-mode cards, blockers effectively gate dispatch —
  manually-picked cards do not.
- **The Done column is blocker-insensitive.** Dragging into Done never
  triggers the confirmation. Any column whose name still contains
  "Backlog" is also blocker-insensitive for back-compat; every other
  column (To Do, In Progress, Review, custom) is blocker-sensitive.

Treat blockers as _guidance_: if you're about to start a card and its
`blockers` contains an entry with `done: false`, stop and either (a)
resolve the blocker first, (b) delete the edge if it's stale, or (c)
surface it to the user and ask.

## Column IDs

Column UUIDs are per-project. Always discover them with
`scripts/board.sh get` before moving cards — hard-coding IDs breaks when
a project re-creates its board.

## Self-reporting flow

1. `scripts/board.sh create` with `session_id` when you pick up work.
2. `scripts/board.sh move` to **In Progress** when you start.
3. `scripts/board.sh comment` when you open a PR or hit a blocker.
4. Move to **Review** when the PR is open, **Done** on merge.
5. Trivial fixes can skip cards; found bugs go to **To Do**.
