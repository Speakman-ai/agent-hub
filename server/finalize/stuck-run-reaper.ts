/**
 * stuck-run-reaper.ts — runtime safety-net for orphaned / hung Finalize runs.
 *
 * WHY THIS EXISTS. A Finalize run's orchestrator loop lives entirely in the Hub
 * process. Three mechanisms recover a run whose loop dies, but each has a hole:
 *
 *   - `boot-recovery.ts` fails stuck run rows — but ONLY on Hub boot. No restart,
 *     no recovery.
 *   - `stall-watchdog.ts` terminates a wedged run — but only arms in live
 *     (`ui_button`) mode; autonomous (`agent_block`) runs are unwatched.
 *   - `finalize-reaper.ts` reaps orphaned DinD containers/volumes — but never the
 *     `finalize_runs` row (it explicitly leaves `ended_at IS NULL` rows alone).
 *
 * So an `agent_block` run whose orchestrator dies or hangs MID-PROCESS (the exact
 * shape of a transient runner-lease-expiry blip with no restart) hangs in
 * `status=running` forever: steps stranded `queued`, no runner alive, the UI
 * stuck on "Running checks…". This reaper is the missing steady-state analog to
 * boot-recovery: a once-a-minute sweep that flips such runs to `infra_error`
 * (their stranded steps → `skipped`) and — reusing the boot-retrigger path —
 * kicks a fresh, non-destructive re-run.
 *
 * SAFETY. The classifier ({@link classifyRuntimeStuckRun}) is conservative by
 * construction so a healthy run is never reaped:
 *   - a run with ANY `running` step is executing → never touched (covers a
 *     legitimately slow 15-min e2e shard);
 *   - a run with no `queued` steps has no stranded work → never touched (covers
 *     between-phase gaps and the done-but-pushing tail);
 *   - an UNREGISTERED run (no live orchestrator in this single-process Hub) is
 *     reaped once idle past the short `orphanIdleMs`;
 *   - a still-REGISTERED run is only reaped past the much larger `hungIdleMs`
 *     backstop, so a run merely waiting on fleet capacity is never reaped.
 */
import type { BroadcastFn, FinalizeRunStatus, Stmts } from '../types.js';
import type { InterruptedFinalizeRun } from './boot-retrigger.js';
import { isFinalizeRunLive, abortFinalizeRunInProcess } from './run-abort-registry.js';

/**
 * The ONLY run status the reaper acts on. Step execution (and the stall this
 * module recovers) happens in `running`. Crucially this EXCLUDES the pre-start
 * statuses — a `queued`/`rebasing`/`reviewing` run that has dispatched step
 * rows but not begun executing shares the reapable shape (`queued_steps > 0`,
 * `running_steps = 0`, no abort handle yet), so reaping by shape alone would
 * fail a pending run on the happy path. Gating on `running` is the discriminator
 * (`started_at` can't be — it's stamped at row INSERT, so it's always set).
 */
export const REAPABLE_RUN_STATUS = 'running';

/**
 * One running run plus the signals the classifier needs (from SQL).
 *
 * `last_activity_ms` is the run's progress clock and MUST be sourced from every
 * signal the orchestrator emits — the last phase write and job timestamps, not
 * just step timestamps. Flooring it at `started_at` alone once reaped healthy
 * runs: `status` first becomes `running` at the tasks phase, so a run that
 * spent 33 minutes in rebase → review → fix rounds (none of which touch step
 * rows) arrived there with a 33-minute-old clock and was killed 4 seconds after
 * dispatching its checks, while the reviewer had just approved it.
 */
export interface RuntimeStuckRunCandidate {
  id: string;
  status: FinalizeRunStatus;
  session_id: string | null;
  card_id: string | null;
  project_id: string | null;
  head_sha: string | null;
  started_at: number | null;
  /** Newest of run.started_at and any step start/end — the progress clock. */
  last_activity_ms: number;
  queued_steps: number;
  running_steps: number;
}

export type StuckRunReason = 'orphaned' | 'hung';

export interface RuntimeStuckRunConfig {
  /** Idle window before an UNREGISTERED (no live orchestrator) run is reaped. */
  orphanIdleMs: number;
  /** Larger backstop before a still-REGISTERED (possibly hung) run is reaped. */
  hungIdleMs: number;
}

export const DEFAULT_RUNTIME_STUCK_RUN_CONFIG: RuntimeStuckRunConfig = {
  orphanIdleMs: 8 * 60_000,
  hungIdleMs: 25 * 60_000,
};

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** Resolve thresholds from env (`FINALIZE_STUCK_RUN_*_IDLE_MS`) with defaults. */
export function resolveRuntimeStuckRunConfig(): RuntimeStuckRunConfig {
  return {
    orphanIdleMs: envInt(
      'FINALIZE_STUCK_RUN_ORPHAN_IDLE_MS',
      DEFAULT_RUNTIME_STUCK_RUN_CONFIG.orphanIdleMs,
    ),
    hungIdleMs: envInt(
      'FINALIZE_STUCK_RUN_HUNG_IDLE_MS',
      DEFAULT_RUNTIME_STUCK_RUN_CONFIG.hungIdleMs,
    ),
  };
}

/**
 * Pure decision: is this candidate a reapable stall, and why? Returns the
 * reason or `null` to leave it alone. No I/O — `isLive` and `nowMs` are
 * injected so this is exhaustively unit-testable.
 */
export function classifyRuntimeStuckRun(
  c: RuntimeStuckRunCandidate,
  opts: { nowMs: number; isLive: (runId: string) => boolean; config: RuntimeStuckRunConfig },
): StuckRunReason | null {
  // Only act on a run that has actually entered step execution. A pre-start
  // run (`queued`/`rebasing`/`reviewing`) can have the same queued-steps shape
  // on the happy path, so reaping it would fail a pending run before it runs.
  if (c.status !== REAPABLE_RUN_STATUS) return null;
  // Something is actively executing — never reap an in-flight step.
  if (c.running_steps > 0) return null;
  // No stranded work — not a stall (between phases, or finishing/pushing).
  if (c.queued_steps <= 0) return null;
  const idleMs = opts.nowMs - c.last_activity_ms;
  // Clock skew / a row stamped in the future: treat as not-yet-idle.
  if (idleMs < 0) return null;
  // Unregistered → orphaned (short window). Still-registered → hung (high
  // backstop), so a run merely waiting on fleet capacity is never reaped.
  const reason: StuckRunReason = opts.isLive(c.id) ? 'hung' : 'orphaned';
  return idleMs >= idleThresholdForReason(reason, opts.config) ? reason : null;
}

/**
 * Idle threshold (ms) a run must exceed to be reaped under each reason. The
 * reaper turns this into the SQL `@cutoff` (nowMs − threshold) so the atomic
 * reap-guard re-checks the SAME idle predicate the classifier used.
 */
export function idleThresholdForReason(
  reason: StuckRunReason,
  config: RuntimeStuckRunConfig,
): number {
  return reason === 'orphaned' ? config.orphanIdleMs : config.hungIdleMs;
}

/**
 * Durable `failure_reason` for a reap. Distinct per reason — an `orphaned` run
 * genuinely has no orchestrator, whereas a `hung` one is still registered, so
 * reporting "no live orchestrator" for it sends anyone reading the row (or the
 * session bubble) after the wrong cause. Both keep the
 * `Finalize run interrupted` prefix that the boot-retrigger crash-loop counter
 * matches on.
 */
export function failureReasonForStuckRun(reason: StuckRunReason): string {
  return reason === 'orphaned'
    ? 'Finalize run interrupted (stalled with no live orchestrator)'
    : 'Finalize run interrupted (orchestrator stopped making progress)';
}

export const STUCK_RUN_REAPER_CRON = '* * * * *';

export interface RuntimeStuckRunReaperDeps {
  stmts: Stmts;
  broadcast: BroadcastFn;
  /** Liveness oracle. Defaults to the in-process abort registry. */
  isLive?: (runId: string) => boolean;
  /** Best-effort trip of a zombie orchestrator. Defaults to the registry. */
  abort?: (runId: string) => void;
  /** Clock seam for tests. Defaults to `Date.now`. */
  nowMs?: () => number;
  config?: RuntimeStuckRunConfig;
  /**
   * Retrigger seam: called once with all runs reaped this tick so the caller
   * can kick fresh, non-destructive re-runs (see boot-retrigger). Omitted in
   * tests so the reaper's DB+broadcast effects can be asserted in isolation.
   */
  onReaped?: (reaped: InterruptedFinalizeRun[]) => void | Promise<void>;
  logger?: Pick<typeof console, 'warn' | 'log'>;
}

export interface ReapedRun {
  runId: string;
  reason: StuckRunReason;
  sessionId: string | null;
}

export interface RuntimeStuckRunReaperResult {
  scanned: number;
  reaped: ReapedRun[];
}

/**
 * One reaper tick. Best-effort: every step is guarded so one bad row can never
 * wedge the sweep. Returns a summary for observability/tests.
 */
export async function runStuckRunReaper(
  deps: RuntimeStuckRunReaperDeps,
): Promise<RuntimeStuckRunReaperResult> {
  const logger = deps.logger ?? console;
  const isLive = deps.isLive ?? isFinalizeRunLive;
  const abort = deps.abort ?? ((id: string) => void abortFinalizeRunInProcess(id));
  const nowMs = deps.nowMs?.() ?? Date.now();
  const config = deps.config ?? resolveRuntimeStuckRunConfig();

  let candidates: RuntimeStuckRunCandidate[];
  try {
    candidates =
      deps.stmts.selectRuntimeStuckFinalizeRunCandidates.all() as RuntimeStuckRunCandidate[];
  } catch (err) {
    logger.warn(`[finalize-stuck-reaper] candidate query failed: ${(err as Error).message}`);
    return { scanned: 0, reaped: [] };
  }

  const reaped: ReapedRun[] = [];
  const snapshots: InterruptedFinalizeRun[] = [];

  for (const c of candidates) {
    let reason: StuckRunReason | null;
    try {
      reason = classifyRuntimeStuckRun(c, { nowMs, isLive, config });
    } catch (err) {
      logger.warn(`[finalize-stuck-reaper] classify failed run=${c.id}: ${(err as Error).message}`);
      continue;
    }
    if (!reason) continue;

    try {
      // The UPDATE re-validates the reapable shape atomically (still `running`,
      // no step now `running`, still has `queued` work, still idle past this
      // cutoff). If the run made any progress since the select snapshot it is a
      // no-op (0 changes → skip), so a TOCTOU race can never fail a live run.
      const cutoff = nowMs - idleThresholdForReason(reason, config);
      const res = deps.stmts.failRuntimeStuckFinalizeRun.run({
        id: c.id,
        cutoff,
        failure_reason: failureReasonForStuckRun(reason),
      }) as {
        changes: number;
      };
      if (!res.changes) continue;
      deps.stmts.failRuntimeStuckFinalizeRunSteps.run(c.id);
      // Trip any zombie orchestrator still registered (no-op if already gone).
      try {
        abort(c.id);
      } catch {
        /* best-effort */
      }
      // Mirror the orchestrator's terminal broadcast pair so the UI flips live
      // (boot-recovery relies on a client reconnect instead; the runtime path
      // must push, since no reconnect is coming).
      const evt = {
        run_id: c.id,
        ...(c.session_id ? { session_id: c.session_id } : {}),
        status: 'infra_error' as const,
        failure_reason: reason,
      };
      deps.broadcast({ type: 'finalize_run_phase_changed', phase: null, ...evt });
      deps.broadcast({ type: 'finalize_run_completed', ...evt });

      reaped.push({ runId: c.id, reason, sessionId: c.session_id });
      if (c.session_id && c.card_id && c.project_id && c.head_sha) {
        snapshots.push({
          runId: c.id,
          sessionId: c.session_id,
          cardId: c.card_id,
          projectId: c.project_id,
          headSha: c.head_sha,
        });
      }
      logger.warn(
        `[finalize-stuck-reaper] reaped run=${c.id} reason=${reason} ` +
          `idleMs=${nowMs - c.last_activity_ms} queued=${c.queued_steps} session=${c.session_id ?? '-'}`,
      );
    } catch (err) {
      logger.warn(`[finalize-stuck-reaper] reap failed run=${c.id}: ${(err as Error).message}`);
    }
  }

  if (snapshots.length > 0 && deps.onReaped) {
    try {
      await deps.onReaped(snapshots);
    } catch (err) {
      logger.warn(`[finalize-stuck-reaper] onReaped failed: ${(err as Error).message}`);
    }
  }

  return { scanned: candidates.length, reaped };
}
