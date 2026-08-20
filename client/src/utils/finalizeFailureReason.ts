// Human-readable explanations for Finalize Code Changes terminal failure
// reason codes. The orchestrator (server/finalize/orchestrator.ts) terminates a
// run with a short machine code like `fix_no_progress`; that code is the only
// failure detail that survives into the `finalize_run_terminal` timeline
// metadata. On its own it reads as "the run just stopped" to anyone who does
// not know the internal vocabulary, so the UI pairs the code with one of these
// plain-English lines.
//
// Keep keys in sync with the failure reasons passed to `terminate()` /
// `outcomeFromFailed()` in server/finalize/orchestrator.ts, the reviewer
// dispatch outcomes in server/finalize/reviewer-dispatch.ts, and the push
// outcomes in server/finalize/push-run.ts.
const FINALIZE_FAILURE_REASON_DESCRIPTIONS = {
  fix_no_progress:
    'The automated fix did not land a new commit, so re-running the checks would fail the same way. The fixer may have committed to a different branch or made no commit.',
  ci_config_invalid:
    'Your .agent-hub/ci.yaml could not be parsed. Fix the config and run Finalize again.',
  // A run with a reviewer phase no longer fails on an absent config — it goes
  // checks-free instead. This code now only reaches the UI from "Run Tests",
  // which has no other phase to fall back on, and from historical rows.
  ci_config_missing:
    'No CI config is set up for this project, so there are no tests to run. Commit a .agent-hub/ci.yaml or store one on the Agent Hub server.',
  review_failed:
    'The in-hub reviewer requested changes that were not resolved before the run ended.',
  review_stalled:
    'The reviewer step could not complete for an infrastructure reason (engine timeout, or every review engine was out of quota / failed to authenticate) — not a problem with your code. Re-run Finalize once a review engine is available again.',
  review_not_converging:
    'Review is not converging: the reviewer kept requesting changes round after round, so the run was handed back for a human to look at the root cause instead of burning the whole time budget.',
  infra_error:
    'A Finalize infrastructure problem interrupted the run. This is usually transient — try again.',
  container_unavailable:
    'The Finalize runner container was unavailable. This is usually transient — try again.',
  timeout: 'A Finalize step ran past its time limit and was stopped.',
  no_worktree: "Finalize could not access this session's worktree.",
  worktree_create_failed: "Finalize could not create this session's worktree.",
  // Deliberately NOT "there were no code changes". This code fires when the
  // diff could not be computed (base/head SHA would not resolve), which a large
  // change set can reach — telling someone with hundreds of modified files that
  // they changed nothing sends them looking in entirely the wrong place.
  no_diff_inputs:
    "Finalize could not work out the diff between this branch and its base. The branch's base ref may be missing or unfetched.",
  stalled: 'A dispatched fix session stopped responding before it finished.',
  stalled_no_response: 'A dispatched fix session stopped responding before it finished.',
  push_gate: 'The push was blocked because the branch state did not satisfy the push gate.',
  head_sha_moved:
    'The branch moved after validation, so the push was refused to avoid pushing unreviewed commits.',
  rebase_aborted:
    'The rebase onto the base branch was aborted, likely due to conflicts that could not be auto-resolved.',
  cancelled: 'The run was cancelled.',
} as Record<string, any>;

/**
 * Map a Finalize terminal failure reason code to a one-line human explanation.
 * Returns null for unknown / empty codes so callers can fall back to the bare
 * code rather than invent a wrong description.
 *
 * @param {unknown} reason
 * @returns {string | null}
 */
export function describeFinalizeFailureReason(reason: any) {
  if (!reason || typeof reason !== 'string') return null;
  return FINALIZE_FAILURE_REASON_DESCRIPTIONS[reason] ?? null;
}
