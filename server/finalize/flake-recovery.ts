/**
 * flake-recovery.ts — detect "retry-until-green" laundering in a Finalize run.
 *
 * A Finalize run re-runs CI checks on every fix-loop iteration (loop_round).
 * A job that FAILED on an earlier round and PASSED on a later round is only
 * legitimately fixed if a fixer commit landed in between that touched the
 * job's code paths. If the job recovered with no relevant code change, the
 * earlier failure was almost certainly a flake and the later pass laundered
 * it into a green merge signal. Industry data puts ~68% of rerun-recovered
 * CI builds in the flaky bucket, so a bare rerun-to-green is NOT merge-safe.
 *
 * This module is pure: it classifies per-job retry history given (a) the
 * recorded attempts and (b) a way to ask which files changed between two
 * heads (+ optional per-job path globs). The orchestrator owns the git I/O
 * and DB persistence; this module owns only the decision, so the full
 * classification truth-table is unit-testable without a worktree.
 *
 * Fail-closed vs conservative: the two are deliberately different. When the
 * change-set between fail→pass cannot be RESOLVED at all (git diff failed),
 * we cannot prove a fixer commit existed, so we mark the recovery
 * `unresolved` → the gate blocks (fail closed). When the change-set IS
 * resolved but a job declares no `paths` and code did change, we can't prove
 * the change is unrelated, so we classify `fixed` rather than block every
 * honest fix (conservative). The unambiguous laundering signals — recovered
 * with NO code change at all, or recovered with a change that misses the
 * job's declared paths — are flagged `flake_recovered`.
 */

export type JobAttemptState = 'queued' | 'running' | 'passed' | 'failed' | 'skipped';

/** One per-round terminal observation of a single job/matrix instance. */
export interface JobRoundAttempt {
  jobId: string;
  matrixKey: string;
  /** 1-indexed loop_round the observation belongs to. */
  round: number;
  state: JobAttemptState;
  /** Post-rebase HEAD the round validated against (the sha CI ran on). */
  headSha: string | null;
}

export type FlakeClassification =
  /** Passed the first (and only) time it ran — never failed. */
  | 'clean'
  /** Failed earlier, then passed after a fixer commit touched its code. */
  | 'fixed'
  /** Failed earlier, then passed with no relevant fixer commit — a flake. */
  | 'flake_recovered'
  /**
   * Failed earlier, then passed, but the change-set between the failing and
   * passing heads could NOT be resolved — we can't prove a relevant fixer
   * commit existed. Fail-closed: this blocks the gate (it never reads clean).
   */
  | 'unresolved'
  /** Final observed state is a failure (or never passed). */
  | 'failed';

export interface JobFlakeVerdict {
  jobId: string;
  matrixKey: string;
  classification: FlakeClassification;
  /** Rounds (1-indexed) the instance was observed failing, ascending. */
  failedRounds: number[];
  /** Round it ultimately passed, or null if it never passed. */
  passedRound: number | null;
  /** Number of failures before the eventual pass (= failedRounds.length). */
  failureCount: number;
}

export interface ClassifyDeps {
  /**
   * Files that changed between two post-rebase heads (e.g.
   * `git diff --name-only <fromHead> <toHead>`). Return `null` when the
   * range cannot be resolved — the classifier then marks the recovery
   * `unresolved`, which fails the gate closed (it cannot prove a fixer
   * commit existed). An empty array means "resolved, nothing changed".
   */
  changedFilesBetween: (fromHead: string, toHead: string) => string[] | null;
  /**
   * Optional per-job code-path globs (ci.yaml `paths:`). When a recovered
   * job declares paths, a fixer commit only legitimizes the recovery if it
   * touched a matching file. Jobs without declared paths fall back to the
   * "any code change counts" heuristic.
   */
  jobPaths?: Map<string, string[]>;
}

// ─── Glob matching ────────────────────────────────────────────────────────

/**
 * Translate a small glob (`**`, `*`, `?`) into an anchored RegExp.
 *
 *   - `**` matches any number of path segments (including `/`).
 *   - `*`  matches anything except `/`.
 *   - `?`  matches a single non-`/` character.
 *
 * Everything else is matched literally. A trailing `/` or `/**` is treated
 * as a directory prefix so `src/` matches `src/a/b.ts`.
 */
function globToRegExp(glob: string): RegExp {
  let normalized = glob.trim();
  // `dir/` → `dir/**`; bare directory prefixes match everything beneath.
  if (normalized.endsWith('/')) normalized += '**';
  let out = '';
  for (let i = 0; i < normalized.length; i++) {
    const ch = normalized[i];
    if (ch === '*') {
      if (normalized[i + 1] === '*') {
        // `**` (optionally followed by `/`) spans path segments.
        if (normalized[i + 2] === '/') {
          out += '(?:.*/)?';
          i += 2;
        } else {
          out += '.*';
          i += 1;
        }
      } else {
        out += '[^/]*';
      }
    } else if (ch === '?') {
      out += '[^/]';
    } else if ('\\^$.|+()[]{}'.includes(ch)) {
      out += `\\${ch}`;
    } else {
      out += ch;
    }
  }
  return new RegExp(`^${out}$`);
}

/** True if `file` matches any of the provided globs. */
export function matchesAnyGlob(file: string, globs: string[]): boolean {
  const normalizedFile = file.replace(/^\.\//, '').replace(/^\/+/, '');
  for (const glob of globs) {
    if (!glob || !glob.trim()) continue;
    if (globToRegExp(glob).test(normalizedFile)) return true;
  }
  return false;
}

// ─── Classification ─────────────────────────────────────────────────────────

function instanceKey(jobId: string, matrixKey: string): string {
  return `${jobId}\u0000${matrixKey}`;
}

/**
 * Classify the retry history of every job/matrix instance in a Finalize run.
 *
 * Attempts may arrive in any order and may include non-terminal observations
 * (`queued` / `running`); those are ignored. The latest terminal state per
 * instance decides the outcome:
 *
 *   - latest is `failed`           → `failed`
 *   - latest is `skipped` / none   → `clean` (never produced a real result)
 *   - latest is `passed`, no prior
 *     failures                     → `clean`
 *   - latest is `passed`, prior
 *     failures, NO relevant fixer  → `flake_recovered`
 *   - latest is `passed`, prior
 *     failures, relevant fixer     → `fixed`
 */
export function classifyJobRetryHistory(
  attempts: JobRoundAttempt[],
  deps: ClassifyDeps,
): JobFlakeVerdict[] {
  const byInstance = new Map<string, JobRoundAttempt[]>();
  for (const a of attempts) {
    const key = instanceKey(a.jobId, a.matrixKey);
    const arr = byInstance.get(key);
    if (arr) arr.push(a);
    else byInstance.set(key, [a]);
  }

  const verdicts: JobFlakeVerdict[] = [];
  for (const group of byInstance.values()) {
    const terminal = group
      .filter((a) => a.state === 'passed' || a.state === 'failed')
      .sort((a, b) => a.round - b.round);
    const { jobId, matrixKey } = group[0];

    if (terminal.length === 0) {
      // Only queued/running/skipped ever observed — not merge-relevant.
      verdicts.push({
        jobId,
        matrixKey,
        classification: 'clean',
        failedRounds: [],
        passedRound: null,
        failureCount: 0,
      });
      continue;
    }

    const last = terminal[terminal.length - 1];
    const failedRounds = terminal.filter((a) => a.state === 'failed').map((a) => a.round);

    if (last.state !== 'passed') {
      verdicts.push({
        jobId,
        matrixKey,
        classification: 'failed',
        failedRounds,
        passedRound: null,
        failureCount: failedRounds.length,
      });
      continue;
    }

    // Final state is `passed`.
    const passedRound = last.round;
    const priorFailures = failedRounds.filter((r) => r < passedRound);
    if (priorFailures.length === 0) {
      verdicts.push({
        jobId,
        matrixKey,
        classification: 'clean',
        failedRounds: priorFailures,
        passedRound,
        failureCount: 0,
      });
      continue;
    }

    verdicts.push({
      jobId,
      matrixKey,
      classification: classifyRecovery(jobId, terminal, passedRound, priorFailures, deps),
      failedRounds: priorFailures,
      passedRound,
      failureCount: priorFailures.length,
    });
  }

  return verdicts;
}

/**
 * Decide whether a recovered instance (failed then passed) was legitimately
 * fixed or laundered a flake into green.
 */
function classifyRecovery(
  jobId: string,
  terminal: JobRoundAttempt[],
  passedRound: number,
  priorFailures: number[],
  deps: ClassifyDeps,
): FlakeClassification {
  const lastFailedRound = priorFailures[priorFailures.length - 1];
  const failHead = terminal.find((a) => a.round === lastFailedRound)?.headSha ?? null;
  const passHead = terminal.find((a) => a.round === passedRound)?.headSha ?? null;

  // Heads identical (or unknown on either side) — no commit landed between
  // the failing round and the passing round, so nothing could have fixed it.
  if (!failHead || !passHead) return 'flake_recovered';
  if (failHead === passHead) return 'flake_recovered';

  const changed = deps.changedFilesBetween(failHead, passHead);
  // Range couldn't be resolved (e.g. git diff failed). We cannot prove a
  // relevant fixer commit exists, so FAIL CLOSED: mark unresolved (→ blocked
  // gate). Never silently downgrade unreadable evidence to a clean `fixed`.
  if (changed === null) return 'unresolved';
  // A code change exists in the range but it left this commit empty / pure
  // upstream rebase with no diff — nothing touched, so it's a flake recovery.
  if (changed.length === 0) return 'flake_recovered';

  const globs = deps.jobPaths?.get(jobId);
  if (globs && globs.length > 0) {
    const touched = changed.some((f) => matchesAnyGlob(f, globs));
    return touched ? 'fixed' : 'flake_recovered';
  }

  // No declared paths but code did change — can't prove it's unrelated to
  // this job, so don't block. Declaring `paths:` on a job enables precise
  // flake detection here.
  return 'fixed';
}

// ─── Gate result + persistence helpers ──────────────────────────────────────

/**
 * The auto-push gate's verdict for a finalize run.
 *
 *   - `clean`            — classification ran and found no laundered flakes.
 *                          Auto-push / auto-merge is allowed.
 *   - `flake_recovered`  — one or more jobs passed only on retry with no
 *                          relevant fixer commit. Auto-push is withheld;
 *                          {@link jobs} lists the offending instances.
 *   - `blocked`          — classification could NOT be performed reliably
 *                          (per-round history failed to persist, the history
 *                          query failed, expected history was missing, or the
 *                          stored state was unparseable). FAIL CLOSED: this is
 *                          treated exactly like a flake for automation, because
 *                          inability to prove a run is clean must never read as
 *                          clean. A human can still push manually.
 *
 * Only `clean` is auto-pushable; {@link flakeGateBlocksAutoPush} folds the
 * other two together.
 */
export type FlakeGateStatus = 'clean' | 'flake_recovered' | 'blocked';

export interface FlakeGateResult {
  status: FlakeGateStatus;
  /** Flake-recovered verdicts (non-empty only for `flake_recovered`). */
  jobs: JobFlakeVerdict[];
  /** Why the gate is `blocked` (omitted otherwise). */
  reason?: string;
}

/** The verdicts that are flake-recovered (passed only after retry, no fix). */
export function flakeRecoveredVerdicts(verdicts: JobFlakeVerdict[]): JobFlakeVerdict[] {
  return verdicts.filter((v) => v.classification === 'flake_recovered');
}

/**
 * Build a gate result from the full classification verdict list.
 *
 *   - any `flake_recovered` job → `flake_recovered` (lists the offenders).
 *   - else any `unresolved` job → `blocked` (fail closed: the change-set for a
 *     recovered job couldn't be resolved, so we can't prove it was a real fix).
 *   - else → `clean`.
 */
export function gateResultFromVerdicts(verdicts: JobFlakeVerdict[]): FlakeGateResult {
  const recovered = flakeRecoveredVerdicts(verdicts);
  if (recovered.length > 0) return { status: 'flake_recovered', jobs: recovered };

  const unresolved = verdicts.filter((v) => v.classification === 'unresolved');
  if (unresolved.length > 0) {
    const labels = unresolved
      .map((v) => (v.matrixKey ? `${v.jobId} [${v.matrixKey}]` : v.jobId))
      .join(', ');
    return blockedGateResult(
      `could not resolve the change-set for recovered job(s) ${labels}; ` +
        `cannot verify whether a fixer commit existed`,
    );
  }

  return { status: 'clean', jobs: [] };
}

/** Fail-closed gate result: classification could not be performed. */
export function blockedGateResult(reason: string): FlakeGateResult {
  return { status: 'blocked', jobs: [], reason };
}

/**
 * Fold INTRA-PHASE recovered flakes into a gate result.
 *
 * A shard that fails a genuine test and then passes on a same-commit config
 * `retries:` rerun recovers WITHIN a single round, so the per-round attempt
 * history the cross-round classifier reads only ever sees its final `passed`
 * state — the flake is invisible to {@link classifyRunFlakeRecovery}. This
 * helper adds those instances as `flake_recovered` verdicts so a red→green
 * retry is treated exactly like a cross-round laundered flake: auto-push is
 * withheld, the instances are listed, and the quarantine lane can still excuse
 * a known-flaky shard (the merge runs BEFORE quarantine).
 *
 * A `blocked` gate is returned unchanged — it already withholds automation
 * (fail-closed) and has no per-instance verdicts to reason about.
 */
export function withIntraPhaseFlakeRecovered(
  gate: FlakeGateResult,
  instances: Array<{ jobId: string; matrixKey: string; failureCount: number }>,
): FlakeGateResult {
  if (instances.length === 0 || gate.status === 'blocked') return gate;
  const seen = new Set(gate.jobs.map((v) => `${v.jobId} ${v.matrixKey}`));
  const added: JobFlakeVerdict[] = [];
  for (const inst of instances) {
    const key = `${inst.jobId} ${inst.matrixKey}`;
    if (seen.has(key)) continue;
    seen.add(key);
    added.push({
      jobId: inst.jobId,
      matrixKey: inst.matrixKey,
      classification: 'flake_recovered',
      // The flake happened within one round, so there is no cross-round fail
      // history to cite; failureCount carries the same-commit rerun count.
      failedRounds: [],
      passedRound: null,
      failureCount: inst.failureCount,
    });
  }
  if (added.length === 0) return gate;
  return { status: 'flake_recovered', jobs: [...gate.jobs, ...added] };
}

function isFlakeVerdict(v: unknown): v is JobFlakeVerdict {
  return (
    !!v &&
    typeof v === 'object' &&
    typeof (v as JobFlakeVerdict).jobId === 'string' &&
    (v as JobFlakeVerdict).classification === 'flake_recovered'
  );
}

/**
 * Serialize a gate result for the `finalize_runs.flake_recovered_jobs` column.
 * A `clean` gate serializes to `null` so the column stays NULL for the common
 * case; `flake_recovered` and `blocked` serialize to a JSON object whose mere
 * presence (non-NULL) is the auto-push block.
 */
export function serializeFlakeGate(result: FlakeGateResult): string | null {
  if (result.status === 'clean') return null;
  return JSON.stringify({
    status: result.status,
    jobs: result.jobs,
    ...(result.reason ? { reason: result.reason } : {}),
  });
}

/**
 * Parse the stored `flake_recovered_jobs` column into a gate result.
 *
 * Fail-closed on ambiguity: a NULL/empty column is `clean` (the only value the
 * orchestrator writes for a verified-clean run), but any NON-NULL value that
 * cannot be parsed into a known gate object is treated as `blocked` rather than
 * silently downgraded to clean.
 */
export function parseFlakeGate(raw: string | null | undefined): FlakeGateResult {
  if (raw == null || raw === '') return { status: 'clean', jobs: [] };
  try {
    const parsed = JSON.parse(raw) as unknown;
    // Current object form: { status, jobs, reason? }.
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const obj = parsed as { status?: unknown; jobs?: unknown; reason?: unknown };
      if (obj.status === 'clean' || obj.status === 'flake_recovered' || obj.status === 'blocked') {
        const jobs = Array.isArray(obj.jobs) ? obj.jobs.filter(isFlakeVerdict) : [];
        return {
          status: obj.status,
          jobs,
          ...(typeof obj.reason === 'string' ? { reason: obj.reason } : {}),
        };
      }
    }
    // Defensive: a bare verdict array (older shape) — treat as flake_recovered
    // when it carries verdicts, else clean.
    if (Array.isArray(parsed)) {
      const jobs = parsed.filter(isFlakeVerdict);
      return jobs.length > 0 ? { status: 'flake_recovered', jobs } : { status: 'clean', jobs: [] };
    }
  } catch {
    /* fall through to fail-closed */
  }
  return { status: 'blocked', jobs: [], reason: 'unparseable flake gate state' };
}

/**
 * Auto-push / auto-merge gate predicate. A run is auto-pushable ONLY when its
 * gate status is `clean`; `flake_recovered` and `blocked` both withhold
 * automation (a human pushing manually is the explicit acknowledgement). This
 * is the fail-closed contract: anything other than a proven-clean classification
 * blocks automation.
 */
export function flakeGateBlocksAutoPush(
  run: { flake_recovered_jobs?: string | null } | null | undefined,
): boolean {
  return parseFlakeGate(run?.flake_recovered_jobs).status !== 'clean';
}

/**
 * Convenience: serialize a full verdict list straight to the column value via
 * {@link gateResultFromVerdicts} (clean → null, flakes → object). For
 * fail-closed `blocked` states use {@link serializeFlakeGate} directly.
 */
export function serializeFlakeRecovered(verdicts: JobFlakeVerdict[]): string | null {
  return serializeFlakeGate(gateResultFromVerdicts(verdicts));
}

/** Parse just the flake-recovered verdicts (for UI surfacing). */
export function parseFlakeRecovered(raw: string | null | undefined): JobFlakeVerdict[] {
  return parseFlakeGate(raw).jobs;
}

/**
 * Convenience: does the run carry actual flake-recovered job verdicts? Distinct
 * from {@link flakeGateBlocksAutoPush}, which also returns true for a `blocked`
 * gate that has no specific verdicts.
 */
export function hasFlakeRecoveredJobs(
  run: { flake_recovered_jobs?: string | null } | null | undefined,
): boolean {
  return parseFlakeGate(run?.flake_recovered_jobs).jobs.length > 0;
}

/** One-line human summary for a timeline/log message. */
export function describeFlakeRecovered(verdicts: JobFlakeVerdict[]): string {
  const recovered = flakeRecoveredVerdicts(verdicts);
  if (recovered.length === 0) return 'no flake-recovered jobs';
  return recovered
    .map((v) => {
      const label = v.matrixKey ? `${v.jobId} [${v.matrixKey}]` : v.jobId;
      const n = v.failureCount;
      return `${label} passed on retry after ${n} failure${n === 1 ? '' : 's'}`;
    })
    .join('; ');
}
