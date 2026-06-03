---
name: ship-pr
description: >-
  Worktree-first GitHub shipping recipe: rebase on main, commit, push,
  and open a PR while preserving Agent Hub kanban conventions and done-state
  contract.
  TRIGGER when: user asks to ship, push, open PR, or finish implementation.
version: 1.0.0
---

# Ship PR (Convention-Preserving)

Use this when code is implemented and ready to publish.

## Finalize-first projects

If the session is **card-linked** and the worktree contains `.agent-hub/ci.yaml`,
do **not** run `gh pr create`. The `gh-pr.sh create` subcommand is blocked by the
Finalize ship gate. Instead:

1. Ensure changes are committed on the session branch.
2. Ask the operator to click **Finalize Code Changes** on the session (or use the
   Finalize API if you are automating with explicit approval).
3. Finalize runs rebase → in-hub review → ci.yaml steps → fix loop → push.

Only use the legacy flow below when there is **no** `.agent-hub/ci.yaml` in the
worktree (project not on Finalize yet).

## Guardrails

- Never commit to `main`.
- Never merge your own PR.
- Use the existing session worktree branch; do not create a second branch unless asked.
- If an open PR already exists for the branch, push commits to it; do not create a duplicate PR.

## Required sequence (legacy — no ci.yaml)

1. Sync and rebase:
```bash
git fetch origin
git rebase origin/main
```

2. Resolve conflicts, rerun tests/lint, and stop if failures remain.

3. Commit with a concise title and clear body.

4. Push:
```bash
git push -u origin "$(git rev-parse --abbrev-ref HEAD)"
```

5. Open PR with `gh pr create` using:
- Title under 70 chars.
- Body sections: `## Summary` and `## Test plan`.
- Kanban link (card id/URL) when the session is card-linked.

## Kanban / Done-state contract

- If scope is complete, move card to Review and comment with PR URL.
- If scope shrank, do not mark Done silently:
  - create follow-up card(s),
  - prefix original with `[Spec]` or `[Partial]`,
  - comment follow-up card IDs and one-line split rationale.

## Failure handling

- If rebase, push, or PR creation fails, report the exact command + error and next proposed fix.
- Do not force-push or auto-merge unless the user explicitly asks.
