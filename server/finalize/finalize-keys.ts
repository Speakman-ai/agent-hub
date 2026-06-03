/**
 * finalize-keys.ts — shared Finalize constants and idempotency helpers.
 *
 * Kept separate from `orchestrator.ts` so lightweight callers (ship gate,
 * route pre-checks) do not import the full state machine module graph.
 */
import { createHash } from 'crypto';
import type { FinalizeRunMode } from '../types.js';

/** Default path of `.agent-hub/ci.yaml` relative to the worktree root. */
export const DEFAULT_CI_CONFIG_RELATIVE_PATH = '.agent-hub/ci.yaml';

/**
 * Compute the idempotency key for a finalize run. SHA-256 over
 * `<project_id>|<branch>|<head_sha>|<mode>` hex-encoded — matches the
 * design doc's §4 contract and the UNIQUE constraint on `finalize_runs`.
 *
 * `mode` is part of the key so the split manual buttons ("Run Tests" =
 * `checks`, "Reviewer" = `review`) can both run against the SAME head
 * SHA without the second click being deduped as a reuse of the first.
 * Omitting `mode` resolves to `'full'`, preserving the historical key
 * for the default pipeline (and any callers that pre-date the split).
 */
export function computeIdempotencyKey(args: {
  projectId: string;
  branch: string;
  headSha: string;
  mode?: FinalizeRunMode;
}): string {
  const mode = args.mode ?? 'full';
  return createHash('sha256')
    .update(`${args.projectId}|${args.branch}|${args.headSha}|${mode}`)
    .digest('hex');
}
