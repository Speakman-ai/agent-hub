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
 *
 * `jobFilter` (single-job "Run Tests" dropdown runs) is folded in as a
 * trailing `|jobs=<sorted,csv>` segment ONLY when non-empty, so a debug
 * run for one job coexists with the full checks run on the same head and
 * two different single-job runs don't dedup onto each other. The segment
 * is omitted entirely for unfiltered runs, keeping every historical key
 * byte-identical.
 */
export function computeIdempotencyKey(args: {
  projectId: string;
  branch: string;
  headSha: string;
  mode?: FinalizeRunMode;
  jobFilter?: string[] | null;
}): string {
  const mode = args.mode ?? 'full';
  let base = `${args.projectId}|${args.branch}|${args.headSha}|${mode}`;
  const jobs = normalizeJobFilter(args.jobFilter);
  if (jobs && jobs.length > 0) {
    base += `|jobs=${jobs.join(',')}`;
  }
  return createHash('sha256').update(base).digest('hex');
}

/**
 * Canonicalize a job-filter list: trim, drop blanks, dedup, sort. Returns
 * `null` for nullish / empty input so callers treat "no filter" uniformly.
 * Sorting makes the idempotency key order-insensitive (selecting `[a,b]`
 * and `[b,a]` is the same run).
 */
export function normalizeJobFilter(jobFilter: string[] | null | undefined): string[] | null {
  if (!jobFilter || jobFilter.length === 0) return null;
  const cleaned = [...new Set(jobFilter.map((j) => j.trim()).filter((j) => j.length > 0))].sort();
  return cleaned.length > 0 ? cleaned : null;
}
