# Autofix — Merge Conflict Resolution

The pull request has become un-mergeable because the base branch moved and
the changes now conflict. Your job is to sync the PR branch with the base
branch and resolve the conflicts correctly.

## Ground rules

1. **Understand both sides before you resolve anything.** Read the PR's
   change AND the change that landed on the base branch. Know what each
   side was trying to accomplish.
2. **Resolve only when intent is clearly compatible.** If the conflicting
   hunks are touching the same logic with different goals, STOP and ask —
   do not guess. An incorrect merge is worse than a stalled PR.
3. **Preserve both behaviors when they're additive.** If one side adds a
   feature and the other adds a different feature in the same region,
   keep both.
4. **Never drop tests during a conflict resolution.** If the two sides
   added tests in the same file, keep both test sets unless they contradict.

## NO LAZY FIXES — hard rules

- Do NOT delete conflicting code on either side just to make the merge
  clean. Both sides landed for a reason.
- Do NOT remove tests that conflict — merge them.
- Do NOT pick one side wholesale without reading both.
- Do NOT add `.skip` / `xit` / `@ts-ignore` / `eslint-disable` to get past
  a build failure introduced by the merge.
- Do NOT weaken assertions to paper over a test that now fails because of
  new base-branch code.

## Workflow

1. **Fetch the latest base.** `git fetch origin` and inspect what changed on
   the base branch since the PR was opened.
2. **Rebase or merge the base into the PR branch** (follow the repo's
   convention — rebase is usually preferred unless the branch is shared).
3. **For each conflict**:
   - Read the code on both sides.
   - If intent is clearly compatible, produce a resolution that preserves
     both behaviors.
   - If intent conflicts, stop. Post a comment on the PR describing the
     conflict and asking for direction.
4. **Run the full test suite locally after resolving.** A clean merge is
   not enough — the combined code must actually work.
5. **Commit.** Format: `autofix(conflict): resolve merge conflicts with
   <base>` with a body that names each conflicting file and describes the
   resolution strategy used.
6. **Push.** If you rebased, this will be a force-push to the PR branch
   — that is expected for rebase-based conflict resolution.

## Before declaring done

- `git status` shows no unmerged paths
- The PR now reports `mergeable: true`
- The full local test/lint/type suite passes on the merged tree
- No tests were dropped; no skip/ignore/silencing patterns appear in the
  diff
- Commit message follows the `autofix(conflict): ...` format
- If you couldn't resolve safely, the PR has a clear comment explaining
  what needs human judgment
