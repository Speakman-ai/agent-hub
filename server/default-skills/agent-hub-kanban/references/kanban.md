# Kanban — Cards, Columns, Comments, Epics

Every project has a board. Default columns (by name; IDs are per-project):
**To Do → In Progress → Review → Done**. Always use
`scripts/board.sh` / `scripts/epics.sh` — never inline curl — so auth and
`PROJECT_ID` are handled uniformly.

Back to [SKILL.md](../SKILL.md).

## Board shape

```bash
scripts/board.sh get     # full board: columns[], cards[], plus metadata
scripts/board.sh list    # flat list of cards
```

Cards carry: `id`, `column_id`, `title`, `description`, `priority`
(`urgent|high|medium|low`), `assignee`, `labels` (comma-separated string),
`session_id`, `epic_id`, `pr_url`, `review_status`, `github_issue_url`,
`position`, timestamps.

## Create a card

Always pass `session_id: $AGENT_HUB_SESSION_ID` when the card belongs to
your current work — the sidebar auto-renames to the card title and
`<agenthub:close-card>` becomes available.

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

## Blockers

Cards can declare dependencies via `kanban_card_blockers`. The table
supports BFS cycle detection (`server/kanban-blockers.ts`) so you can't
create a loop.

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
