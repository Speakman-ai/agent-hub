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
 * `mode` is part of the key for back-compat with historical rows: a
 * `'full'` run (the one Finalize button) exercises both checks and the
 * reviewer, but legacy `'checks'` / `'review'` rows (and automation that
 * still targets a single phase) keep their own keys. Omitting `mode`
 * resolves to `'full'`, preserving the historical key for the default
 * pipeline.
 *
 * `attempt` is the manual re-run discriminator. The Finalize strip is an
 * append-only timeline of reviews/tests/code-changes — when a user
 * explicitly re-triggers a phase against a head whose previous run already
 * finished (terminal), the kickoff layer bumps `attempt` so the re-run
 * gets its OWN idempotency key, `finalize_runs` row, and timeline bubble
 * instead of deduping ("Reused") onto the finished run. Folded in as a
 * trailing `|attempt=<n>` segment ONLY for attempt > 1, so attempt 1 (the
 * first run, and all automated runs) keeps every historical key
 * byte-identical.
 */
export function computeIdempotencyKey(args: {
  projectId: string;
  branch: string;
  headSha: string;
  mode?: FinalizeRunMode;
  attempt?: number;
}): string {
  const mode = args.mode ?? 'full';
  let base = `${args.projectId}|${args.branch}|${args.headSha}|${mode}`;
  const attempt = args.attempt ?? 1;
  if (attempt > 1) {
    base += `|attempt=${attempt}`;
  }
  return createHash('sha256').update(base).digest('hex');
}
