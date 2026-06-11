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

## Finalize-first projects

If the session is **card-linked** and the worktree contains `.agent-hub/ci.yaml`,
do **not** run `gh pr create`. The `gh-pr.sh create` subcommand is blocked by the
Finalize ship gate. Instead:

1. Ensure changes are committed on the session branch.
2. Ask the operator to click **Finalize Code Changes** on the session.
3. Finalize runs rebase → in-hub review → ci.yaml steps → fix loop → push.

Only use the legacy workflow below when there is **no** `.agent-hub/ci.yaml` in the
worktree.

## Agent Hub-hosted repositories

Check the remote first: `git remote get-url origin`. If it is **not** a
`github.com` URL (a local path under `.agent-hub/data/git/` or a Hub URL
containing `/git/<project>.git`), this project's repository is hosted on
Agent Hub itself. Push as normal (step 6 below — `origin` IS the Hub),
but do **not** use `gh pr create` (there is no GitHub repo to receive it).
Create the pull request via the Agent Hub API instead:

```bash
ah-api.sh POST "/api/projects/$PROJECT_ID/pulls" '{
  "headBranch": "'"$(git rev-parse --abbrev-ref HEAD)"'",
  "title": "<concise title under 70 chars>",
  "body": "## Summary\n…\n\n## Test plan\n…"
}'
```

The response contains `prUrl` (an in-app URL like `/projects/<id>/pulls/<n>`)
— use it for the card comment and the Review move in step 8. The call is
idempotent: an open Hub PR for the branch is reused and refreshed.

## Guardrails

- Never commit to `main`.
- Never merge your own PR.
- Use the existing session worktree branch; do not create a second branch unless asked.
- If an open PR already exists for the branch, push commits to it; do not create a duplicate PR.
- If a kanban card is already linked to this session, reuse it — do not create a duplicate card.

## Workflow (legacy — no ci.yaml)

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
7. Open PR — `gh pr create` (or the github skill) for GitHub-hosted repos, or the
   Agent Hub API call from the "Agent Hub-hosted repositories" section above — using:
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
- PR URL
