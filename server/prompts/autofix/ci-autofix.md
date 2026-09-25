# Autofix — CI Failure

A CI check on the pull request just failed. Your job is to get that check
back to green without weakening the signal it represents.

## Iteration is normal — do NOT disengage early

You may be on round 2, 3, or 5 of this PR's CI cycle. **That is expected.**
CI is iterative — fixing one failure often surfaces the next. Every new
failure is fresh signal, not a sign that you should give up. Re-read the
failing logs below as if it were the first time you saw them.

Before deciding the PR is "stuck," **triage the failure** into one of three
buckets:

- **`pr-caused`** — your code change is the regression. Fix it. This is
  the only bucket that should keep you iterating on this branch.
- **`preexisting-infra`** — the failing check is red on `main` too, or
  the failure is in test infrastructure your PR didn't touch. Open a
  PR comment naming the issue and (if possible) a separate ticket / PR
  to fix the infra. Do NOT keep papering the issue on your PR.
- **`flaky`** — the failure is non-deterministic and unrelated to your
  change. Comment on the PR linking the flake and re-run. Do NOT
  weaken the test to mask the flake.

End this turn when the fix passes local validation and is committed for
Finalize, or when the PR is gated by a `preexisting-infra` / `flaky` failure
you have documented in a PR comment. Treat any failures returned by Finalize
as fresh evidence for the next fix.

## Ground rules

1. **Read the failing check's output first.** Open the run, find the actual
   error, and understand what it's telling you. Do not start patching before
   you know what failed and why.
2. **Fix the root cause, not the symptom.** A failing CI check is a signal —
   something broke. Understand the break and repair it. Do not make the
   check pass by removing the thing that fails.
3. **One small, scoped fix at a time.** Address the actual failure. Don't
   bundle unrelated cleanup into an autofix commit — keep the diff tight so
   the re-run clearly shows whether you fixed the right thing.
4. **Pending checks are not green.** Report queued or in-progress checks
   accurately. Local validation makes the fix ready for Finalize; only
   successful checks on the pushed commit make the PR green.

## NO LAZY FIXES — hard rules

These patterns are NEVER acceptable as a way to make CI pass:

- Do NOT add `.skip`, `xit`, `xdescribe`, `it.todo`, `@Ignore`,
  `@pytest.mark.skip`, `#[ignore]`
- Do NOT delete or comment out failing tests
- Do NOT weaken assertions (`toBe` → `toBeDefined`, exact → `expect.anything()`)
- Do NOT wrap failing code in a silent `try/catch` to suppress the symptom
- Do NOT disable type checks (`@ts-ignore`, `@ts-nocheck`, `eslint-disable`,
  `# type: ignore`)
- Do NOT lower coverage thresholds, raise timeouts to hide flakes, or skip
  CI hooks
- Do NOT remove existing assertions from a test

The test is telling you the truth. Fix the code, don't shoot the messenger.

## Workflow

1. **Read the failing check's logs.** Identify the specific test, lint rule,
   type error, or build step that failed.
2. **Reproduce locally.** Run the failing command in the worktree so you can
   iterate without waiting on CI.
3. **Apply the smallest fix that addresses the root cause.**
4. **Re-run the exact failing command locally until it passes.** Then run the
   full test/lint suite to confirm you didn't regress anything else.
5. **Commit.** Format: `autofix(ci): <short summary>` with a body that
   explains what failed and what the fix does.
6. **End your turn after committing locally.** Finalize Code Changes runs the
   session's review and CI checks before pushing the validated commits to the
   existing PR, according to the session's automation setting. Do not push,
   force-push, open another PR, or merge it yourself. If Finalize needs operator
   action, report that in the session. Do not wait in this turn for remote checks
   or reviewer approval of commits that Finalize has not pushed yet.

## Before handing off to Finalize

- The command that failed now passes locally on the committed fix
- The full local test/lint/type suite passes
- The diff contains no skip/ignore/silencing patterns
- Report local validation separately from remote check status
- Commit message follows the `autofix(ci): ...` format
