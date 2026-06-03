/**
 * finalize-keys.ts — shared Finalize constants and idempotency helpers.
 *
 * Kept separate from `orchestrator.ts` so lightweight callers (ship gate,
 * route pre-checks) do not import the full state machine module graph.
 */
import { createHash } from 'crypto';

/** Default path of `.agent-hub/ci.yaml` relative to the worktree root. */
export const DEFAULT_CI_CONFIG_RELATIVE_PATH = '.agent-hub/ci.yaml';

/**
 * Compute the idempotency key for a finalize run. SHA-256 over
 * `<project_id>|<branch>|<head_sha>` hex-encoded — matches the design
 * doc's §4 contract and the UNIQUE constraint on `finalize_runs`.
 */
export function computeIdempotencyKey(args: {
  projectId: string;
  branch: string;
  headSha: string;
}): string {
  return createHash('sha256')
    .update(`${args.projectId}|${args.branch}|${args.headSha}`)
    .digest('hex');
}
