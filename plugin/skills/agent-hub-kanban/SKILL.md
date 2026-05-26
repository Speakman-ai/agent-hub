---
name: agent-hub-kanban
description: >-
  Agent Hub kanban board operations — list, create, move, update, and comment
  on cards; manage epics and card blockers. Covers the project→board hierarchy,
  the To Do → In Progress → Review → Done column contract, autonomous-assignment
  rules, the Done-state contract, and card↔PR linkage. TRIGGER only on Agent
  Hub kanban signals: the words "kanban", "board", "card", "epic", "blocker";
  the column names "To Do", "In Progress", "Review", "Done" in an Agent Hub
  context; URLs under /api/projects/<slug>/board/; or the wrappers
  scripts/board.sh, scripts/epics.sh, scripts/kanban-*.sh. DO NOT TRIGGER on
  third-party trackers (Linear, Jira, Trello, Asana, GitHub Projects,
  ClickUp, Notion boards) — those each have their own skill. DO NOT TRIGGER
  on generic project-management questions with no Agent Hub board in view.
category: platform
version: 1.0.0
keep-coding-instructions: true
---

# Agent Hub — Kanban

Every project has a board with the columns **To Do → In Progress → Review →
Done**. Full reference: **[references/kanban.md](references/kanban.md)**.
Scripts live in the shared core tree (`agent-hub/scripts/`) — pass
`PROJECT_ID` and the wrappers handle auth + base URL.

> **Never paste raw `curl` into the chat.** The wrappers under
> `scripts/` are the single source of truth.

## Self-reporting flow

1. **Create** a card linked to your session when you pick up work. Wrappers
   auto-link via `$AGENT_HUB_SESSION_ID` (header + default `--session-id`);
   you can still pass `session_id` explicitly in JSON when using `board.sh
   create`.
2. **Move** to In Progress when you start; **Review** when the PR is open;
   **Done** on merge.
3. **Comment** on the card when opening a PR, hitting a blocker, or
   finishing a subtask.

```bash
# Deterministic flag-based wrappers (preferred for agent use):
scripts/get-board-state.sh                          # full board JSON
scripts/kanban-list.sh --column "In Progress"       # filtered card list
scripts/resolve-column-id.sh "In Progress"          # name → UUID
scripts/kanban-create-card.sh --title "…" --column "To Do" \
  --priority high
  # --session-id defaults to $AGENT_HUB_SESSION_ID when set
scripts/kanban-move-card.sh <cardId> "Review"

# Subcommand-style wrappers (raw JSON, thinner layer):
scripts/board.sh  get | list | create | move | update | comment
scripts/epics.sh  list | create | link | unlink
```

## Cards, epics, blockers

Cards carry `priority` (`urgent|high|medium|low`), `assignee`, `labels`,
`session_id`, optional `epic_id`, `pr_url`, `review_status`,
`github_issue_url`, `position`, and timestamps. **Do not self-stamp
`assignee` on create** — leave it `null` and let the assign endpoint or the
autonomous loop fill it in. The server normalises a stray agent id to the
agent's display name, but pre-stamping reserves the card out of the
autonomous pool, which is almost never what you want.

Epics group cards; autonomous epics (`autonomous: true`) drive dispatch.
Blockers (`kanban_card_blockers`) cycle-check on insert.

## Done-state contract

A card may move to **Done** only when:

- **(a) Full scope shipped** — every acceptance criterion delivered in
  user-visible form, OR
- **(b) Spec / Partial** — title prefixed `[Spec]` / `[Partial]` AND a
  comment on the card lists the follow-up card IDs.

Otherwise the card stays in **In Progress** or **Review**. The
end-of-session announcement must state the user-visible delta. Full rules:
wiki page *Kanban Done-State Contract — When a Card May Move to Done*.

## Column IDs are per-project

Column UUIDs are per-project; always discover them with
`scripts/board.sh get` (or `scripts/resolve-column-id.sh "<name>"`) before
moving cards. Hard-coding IDs breaks when a project re-creates its board.

## See also

- Core skill `agent-hub` — env contract, auth, error self-reporting,
  cross-cutting wrappers.
- `references/kanban.md` — full endpoint reference (Read with the absolute
  path emitted in the injection).
