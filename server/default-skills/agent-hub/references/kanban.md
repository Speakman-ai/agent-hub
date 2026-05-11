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
`autonomous_iterations`, `position`, timestamps.

## Create a card

Always pass `session_id: $AGENT_HUB_SESSION_ID` when the card belongs to
your current work — the sidebar auto-renames to the card title and
`<agenthub:close-card>` becomes available.

```bash
scripts/board.sh create '{
  "title": "Short descriptive title",
  "description": "Details about the task",
  "columnId": "<column-uuid>",
  "priority": "high",
  "assignee": "your-agent-name",
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
