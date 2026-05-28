---
name: create-ticket-and-pr
description: >-
  Create a kanban tracking card (if needed), commit, push, and open a pull
  request from the current session worktree. TRIGGER when: the user clicks
  Create ticket & PR, asks to ship ad-hoc session work, or a card-assignment /
  autonomous session ends with publishable changes (auto-ship at session end).
version: 1.0.0
---

# Create ticket and PR

Use when the user wants ad-hoc session work published through a clean branch workflow with kanban tracking.

## Guardrails

- Never commit to `main`.
- Never merge your own PR.
- Use the existing session worktree branch; do not create a second branch unless asked.
- If an open PR already exists for the branch, push commits to it; do not create a duplicate PR.
- If a kanban card is already linked to this session, reuse it — do not create a duplicate card.

## Workflow

1. Ensure the working tree is clean or explicitly handled (commit or stash as appropriate).
2. **Kanban ticket** — If no card is linked to this session, create one via the `agent-hub` / `kanban` skill (In Progress column, link `session_id`, sensible title from session name or diff). If a card exists, note its id in the PR body.
3. Sync and rebase on the project base branch:
```bash
git fetch origin
git rebase origin/main
```
   (Use the epic/card `pr_base_branch` when set instead of `main`.)
4. Resolve conflicts, rerun tests/lint, and stop if failures remain.
5. Commit with a concise title and clear body.
6. Push:
```bash
git push -u origin "$(git rev-parse --abbrev-ref HEAD)"
```
7. Open PR with `gh pr create` (or the github skill) using:
   - Title under 70 chars.
   - Body sections: `## Summary` and `## Test plan`.
   - Kanban link (card id/URL) when the session is card-linked.
8. Move the card to **Review** and comment on the card with the PR URL when implementation scope is complete.

## Kanban / Done-state contract

- If scope is complete, move card to Review and comment with PR URL.
- If scope shrank, do not mark Done silently:
  - create follow-up card(s),
  - prefix original with `[Spec]` or `[Partial]`,
  - comment follow-up card IDs and one-line split rationale.

## Failure handling

- If rebase, push, or PR creation fails, report the exact command + error and next proposed fix.
- Do not force-push or enable auto-merge unless the user explicitly asks.

## Output

- Kanban card id (new or reused)
- Branch name
- PR summary and test notes
- PR URL
