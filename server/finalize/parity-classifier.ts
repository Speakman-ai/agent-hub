/**
 * parity-classifier.ts — Finalize↔GitHub parity classifier.
 *
 * Why this exists
 * ───────────────
 * Finalize Code Changes runs a pre-PR CI pipeline locally (DinD runners, the
 * same `ci.yaml`) and reaches its own verdict on whether a branch is green. We
 * want to retire GitHub Actions as the source of truth, but we can only do that
 * once we can prove Finalize and GitHub agree on the same commit — and, more
 * importantly, that Finalize never says "green" when GitHub says "red".
 *
 * PR webapp#1001 (commit 6ad87ec) was exactly that failure: Finalize
 * green / GitHub red (0 failing jobs vs 3). A single such "false green" is
 * dangerous because it would let a broken commit reach `main` if GitHub were
 * retired. This module is the pure classifier the parity harness uses to label
 * every observed (Finalize verdict, GitHub verdict) pair so the dataset can be
 * mined for false-greens.
 *
 * Everything here is a pure function — no DB, no I/O. The store
 * (`parity-store.ts`) calls these to derive the `divergence_class` it persists.
 */
import type { FinalizeRunStatus } from '../types.js';

/**
 * A normalized verdict for one side of the comparison.
 *
 *   - `'green'`   — all checks passed; the branch is shippable.
 *   - `'red'`     — at least one check failed; the branch is broken.
 *   - `'unknown'` — the verdict cannot be determined yet (run still in flight,
 *                   no checks reported, cancelled, infra error). An `unknown`
 *                   on either side makes the pair `indeterminate` — we never
 *                   guess, because a wrong guess pollutes the false-green count.
 */
export type ParityVerdict = 'green' | 'red' | 'unknown';

/**
 * How a (Finalize, GitHub) verdict pair relates.
 *
 *   - `agree_green`   — both green. The happy path; safe to retire GitHub for
 *                       commits that look like this.
 *   - `agree_red`     — both red. Also fine: both systems caught the breakage.
 *   - `false_green`   — Finalize green, GitHub red. **DANGEROUS.** Finalize
 *                       would have shipped a commit GitHub knows is broken.
 *                       This is the metric the whole epic gates on (~0 over
 *                       200+ PRs).
 *   - `false_red`     — Finalize red, GitHub green. Safe but annoying: Finalize
 *                       blocked a commit GitHub would have passed. Costs
 *                       developer time, never ships breakage.
 *   - `indeterminate` — either side is `unknown`; not a divergence, not an
 *                       agreement. Excluded from the false-green exit bar.
 */
export type DivergenceClass =
  | 'agree_green'
  | 'agree_red'
  | 'false_green'
  | 'false_red'
  | 'indeterminate';

export const DIVERGENCE_CLASSES: readonly DivergenceClass[] = [
  'agree_green',
  'agree_red',
  'false_green',
  'false_red',
  'indeterminate',
] as const;

export function isDivergenceClass(value: unknown): value is DivergenceClass {
  return typeof value === 'string' && (DIVERGENCE_CLASSES as readonly string[]).includes(value);
}

/** One CI job/check, normalized to `{ name, state }` for storage + display. */
export interface ParityJob {
  name: string;
  /** Normalized per-job state. See {@link normalizeFinalizeJobState}. */
  state: ParityVerdict | 'skipped';
}

/**
 * Classify a single (Finalize, GitHub) verdict pair.
 *
 * The matrix:
 *
 *                 GitHub green   GitHub red    GitHub unknown
 *   Finalize green  agree_green   false_green   indeterminate
 *   Finalize red    false_red     agree_red     indeterminate
 *   Finalize unk.   indeterminate indeterminate indeterminate
 */
export function classifyDivergence(
  finalize: ParityVerdict,
  github: ParityVerdict,
): DivergenceClass {
  if (finalize === 'unknown' || github === 'unknown') return 'indeterminate';
  if (finalize === github) {
    return finalize === 'green' ? 'agree_green' : 'agree_red';
  }
  // finalize !== github, both are green/red.
  if (finalize === 'green' && github === 'red') return 'false_green';
  return 'false_red'; // finalize red, github green
}

/** True for the two real divergence classes (false_green | false_red). */
export function isDivergence(cls: DivergenceClass): boolean {
  return cls === 'false_green' || cls === 'false_red';
}

/**
 * True only for `false_green` — the dangerous class the epic exit bar gates
 * on. The parity store fires an alert whenever this returns true.
 */
export function isDangerousDivergence(cls: DivergenceClass): boolean {
  return cls === 'false_green';
}

// ─── Verdict normalizers ──────────────────────────────────────────────

const FINALIZE_GREEN_STATUSES: ReadonlySet<FinalizeRunStatus> = new Set([
  'ready_to_push',
  'pushed',
]);

const FINALIZE_RED_STATUSES: ReadonlySet<FinalizeRunStatus> = new Set([
  'failed',
  'timed_out',
  'stalled_no_response',
]);

/**
 * Map a {@link FinalizeRunStatus} to a parity verdict.
 *
 *   - green: `ready_to_push`, `pushed` (review + CI passed)
 *   - red:   `failed`, `timed_out`, `stalled_no_response`
 *   - unknown: every non-terminal status plus `infra_error` / `cancelled`,
 *     which say nothing about whether the code itself is green or red.
 */
export function finalizeStatusToVerdict(status: FinalizeRunStatus): ParityVerdict {
  if (FINALIZE_GREEN_STATUSES.has(status)) return 'green';
  if (FINALIZE_RED_STATUSES.has(status)) return 'red';
  return 'unknown';
}

/**
 * A GitHub check-run conclusion that means the check failed. Mirrors the
 * GitHub Checks API `conclusion` enum. `cancelled` is treated as a failure for
 * parity purposes — a cancelled required check is not a pass, and counting it
 * as `unknown` would silently drop real red signal.
 */
const GITHUB_FAILING_CONCLUSIONS: ReadonlySet<string> = new Set([
  'failure',
  'timed_out',
  'action_required',
  'startup_failure',
  'stale',
  'cancelled',
]);

/**
 * Conclusions that count as a pass. `neutral` and `skipped` are non-blocking
 * outcomes (e.g. a conditional job that did not run) and are treated as green.
 */
const GITHUB_PASSING_CONCLUSIONS: ReadonlySet<string> = new Set(['success', 'neutral', 'skipped']);

interface RawCheckRun {
  name?: unknown;
  status?: unknown;
  conclusion?: unknown;
}

/**
 * Reduce a list of normalized GitHub check-runs (see
 * `normalizeCheckRuns` in `routes/pr-list.ts`) to a single parity verdict.
 *
 *   - `unknown` when there are no checks at all, or any check has not yet
 *     completed (`status !== 'completed'` or a null conclusion). We never call
 *     a still-running suite green or red.
 *   - `red` when any completed check has a failing conclusion.
 *   - `green` when every check completed with a passing conclusion.
 *
 * Failing checks dominate: a suite with one failure and one in-progress check
 * is still `red` (GitHub already knows it is broken). The in-progress guard
 * only applies when nothing has failed yet.
 */
export function githubChecksToVerdict(checks: ReadonlyArray<unknown>): ParityVerdict {
  if (!Array.isArray(checks) || checks.length === 0) return 'unknown';
  let sawIncomplete = false;
  for (const raw of checks) {
    const chk = (raw ?? {}) as RawCheckRun;
    const status = typeof chk.status === 'string' ? chk.status : '';
    const conclusion = typeof chk.conclusion === 'string' ? chk.conclusion : null;
    if (conclusion && GITHUB_FAILING_CONCLUSIONS.has(conclusion)) {
      return 'red';
    }
    if (status !== 'completed' || conclusion === null) {
      sawIncomplete = true;
      continue;
    }
    if (!GITHUB_PASSING_CONCLUSIONS.has(conclusion)) {
      // An unrecognized terminal conclusion — be conservative and treat it as
      // not-green so a future GitHub enum value cannot silently pass.
      return 'red';
    }
  }
  return sawIncomplete ? 'unknown' : 'green';
}

/**
 * Normalize a single Finalize job/step state (`passed` | `failed` | `skipped`
 * | `queued` | `running`) to a {@link ParityJob} state.
 */
export function normalizeFinalizeJobState(state: string): ParityVerdict | 'skipped' {
  if (state === 'passed') return 'green';
  if (state === 'failed') return 'red';
  if (state === 'skipped') return 'skipped';
  return 'unknown';
}

/**
 * Normalize a single GitHub check-run conclusion to a {@link ParityJob} state.
 */
export function normalizeGithubCheckState(
  status: string,
  conclusion: string | null,
): ParityVerdict | 'skipped' {
  if (conclusion === 'skipped' || conclusion === 'neutral') return 'skipped';
  if (conclusion && GITHUB_FAILING_CONCLUSIONS.has(conclusion)) return 'red';
  if (conclusion === 'success') return 'green';
  if (status !== 'completed' || conclusion === null) return 'unknown';
  return 'unknown';
}

/** Project Finalize per-job rows into the stored `{ name, state }` shape. */
export function finalizeJobsToParityJobs(
  jobs: ReadonlyArray<{ name: string; state: string }>,
): ParityJob[] {
  return jobs.map((j) => ({ name: j.name, state: normalizeFinalizeJobState(j.state) }));
}

/** Project normalized GitHub check-runs into the stored `{ name, state }` shape. */
export function githubChecksToParityJobs(checks: ReadonlyArray<unknown>): ParityJob[] {
  if (!Array.isArray(checks)) return [];
  return checks.map((raw) => {
    const chk = (raw ?? {}) as RawCheckRun;
    const name = typeof chk.name === 'string' ? chk.name : '';
    const status = typeof chk.status === 'string' ? chk.status : '';
    const conclusion = typeof chk.conclusion === 'string' ? chk.conclusion : null;
    return { name, state: normalizeGithubCheckState(status, conclusion) };
  });
}
