---
name: babysit
description: >-
  Keep a PR merge-ready by triaging comments, resolving clear conflicts, and
  fixing CI in a loop. TRIGGER when: user says "babysit", "keep PR green",
  "fix CI", "watch this PR", or asks to maintain a pull request.
version: 1.0.0
keep-coding-instructions: true
---

# Babysit PR

Your job is to get this PR to a merge-ready state.

Check PR status, comments, and latest CI and resolve any issues until the PR is ready to merge.

1. Comments: Review every comment (including Bugbot) before acting. Fix only comments you agree with; explain when you disagree or are unsure.
2. Merge conflicts: When there are conflicts, sync with base branch. Resolve merge conflicts only when intent is clearly the same, otherwise stop and ask for clarification.
3. CI: Fix CI issues that come up with small scoped fixes. Push them and re-watch CI until mergeable + green + comments triaged.
4. **Pending checks**: A PR is NOT green until ALL checks have completed. If any check is pending, queued, or in-progress (e.g., Bugbot still running), wait for the next run — do NOT declare the PR ready.
