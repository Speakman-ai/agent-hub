/**
 * boot-retrigger.ts — re-trigger interrupted Finalize runs after a Hub restart.
 *
 * When the Hub restarts (deploy/crash) mid-Finalize, the orchestrator state is
 * gone and `boot-recovery.ts` marks the run `infra_error`. But the work product
 * — the session's branch and its commits — is durable in git, and a Finalize
 * run is a pure function of `(branch, head_sha)`. So instead of stranding the
 * run, we re-trigger a FRESH run from scratch for each affected session. This is
 * the "idempotent jobs are safe to re-run on deploy" pattern: the push step is
 * already guarded (existing-PR reuse + `--force-with-lease`), review re-runs
 * cleanly (the verdict isn't persisted until the turn ends), and each kickoff
 * re-derives HEAD from the live worktree.
 *
 * We re-trigger ALL interrupted runs (one per session) rather than dropping any
 * — stranding a run as `infra_error` would turn "the deploy was slow" into "the
 * run failed and needs a manual retrigger," which is strictly worse. Real
 * concurrency backpressure is owned elsewhere, not here: on the remote/fleet
 * backend the fleet queue + `FINALIZE_FLEET_MAX_AGENTS` already bound how many
 * jobs actually run at once; a global concurrent-run gate (the right home for
 * single-host backpressure, benefiting every trigger path) is a separate
 * follow-up. Capping kickoffs here would not even bound running work, since
 * `startFinalizeRunBackground` returns as soon as the orchestrator is launched.
 *
 * The one guard that belongs here is the **crash-loop cap** — a run that
 * crashes the Hub mid-finalize would otherwise loop forever (boot → retrigger →
 * crash → boot → …). We count how many times the same (session, head_sha) has
 * already been swept to infra_error and stop after `maxGenerations`. That's a
 * correctness guard, not a load guard.
 *
 * Re-triggers use `triggerSource: 'ui_button'` so `resolveFinalizeAttempt`
 * advances past the just-swept infra_error row to a fresh attempt (a new run +
 * timeline bubble) rather than de-duping onto the dead row.
 */
import type { KanbanCardRow, RouteDeps, SessionRow } from '../types.js';
import {
  startFinalizeRunBackground,
  type StartFinalizeRunBackgroundResult,
} from './trigger-run.js';

/** Snapshot of one run that was in flight when the Hub went down. */
export interface InterruptedFinalizeRun {
  runId: string;
  sessionId: string;
  cardId: string;
  projectId: string;
  headSha: string;
}

export interface BootRetriggerPlanItem {
  sessionId: string;
  cardId: string;
  projectId: string;
  runId: string;
  headSha: string;
}

export interface BootRetriggerSkip {
  sessionId: string;
  runId: string;
  reason: string;
}

export interface BootRetriggerPlan {
  retrigger: BootRetriggerPlanItem[];
  skipped: BootRetriggerSkip[];
}

export const DEFAULT_BOOT_RETRIGGER_MAX_GENERATIONS = 3;

/**
 * Pure planner: decide which interrupted runs to re-trigger. Applies per-session
 * dedup and the crash-loop generation cap — but NO load cap: every eligible
 * session is re-triggered (see file header for why dropping overflow is worse
 * than queueing). No I/O — the caller injects `priorInterruptedCount` so this is
 * unit-testable without a DB.
 */
export function planBootRetriggers(args: {
  interrupted: InterruptedFinalizeRun[];
  priorInterruptedCount: (sessionId: string, headSha: string) => number;
  maxGenerations: number;
}): BootRetriggerPlan {
  const retrigger: BootRetriggerPlanItem[] = [];
  const skipped: BootRetriggerSkip[] = [];
  const seenSessions = new Set<string>();

  for (const run of args.interrupted) {
    if (seenSessions.has(run.sessionId)) {
      skipped.push({ sessionId: run.sessionId, runId: run.runId, reason: 'duplicate_session' });
      continue;
    }
    seenSessions.add(run.sessionId);

    const generations = args.priorInterruptedCount(run.sessionId, run.headSha);
    if (generations >= args.maxGenerations) {
      skipped.push({
        sessionId: run.sessionId,
        runId: run.runId,
        reason: `crash_loop_cap (generations=${generations} >= ${args.maxGenerations})`,
      });
      continue;
    }

    retrigger.push({
      sessionId: run.sessionId,
      cardId: run.cardId,
      projectId: run.projectId,
      runId: run.runId,
      headSha: run.headSha,
    });
  }

  return { retrigger, skipped };
}

/** Injectable kickoff seam so the executor can be tested without git/spawn. */
export type BootRetriggerStartFn = (
  deps: RouteDeps,
  item: BootRetriggerPlanItem,
) => Promise<StartFinalizeRunBackgroundResult>;

async function defaultStart(
  deps: RouteDeps,
  item: BootRetriggerPlanItem,
): Promise<StartFinalizeRunBackgroundResult> {
  const session = deps.stmts.getSession.get(item.sessionId) as SessionRow | undefined;
  const card = deps.stmts.getKanbanCard.get(item.cardId) as KanbanCardRow | undefined;
  const project = deps.findProject(item.projectId);
  if (!session?.worktree_path || !card || !project) {
    return {
      ok: false,
      error: 'context_unresolved',
      message: `session/card/project missing for session=${item.sessionId}`,
    };
  }
  return startFinalizeRunBackground(deps, {
    project,
    card,
    session,
    // Advance past the just-swept infra_error row to a fresh attempt + bubble.
    triggerSource: 'ui_button',
    triggeredByUserId: 'automation',
  });
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/**
 * Re-trigger interrupted Finalize runs captured by `failStuckFinalizeRunsOnBoot`.
 * Best-effort and self-contained: every failure is logged and swallowed so a
 * bad row can never block boot. Returns counts for observability/tests.
 */
export async function retriggerInterruptedFinalizeRunsOnBoot(
  deps: RouteDeps,
  interrupted: InterruptedFinalizeRun[],
  opts?: {
    maxGenerations?: number;
    start?: BootRetriggerStartFn;
  },
): Promise<{ retriggered: number; skipped: number }> {
  if (interrupted.length === 0) return { retriggered: 0, skipped: 0 };

  const maxGenerations =
    opts?.maxGenerations ??
    envInt('FINALIZE_BOOT_RETRIGGER_MAX_GENERATIONS', DEFAULT_BOOT_RETRIGGER_MAX_GENERATIONS);

  const plan = planBootRetriggers({
    interrupted,
    priorInterruptedCount: (sessionId, headSha) => {
      try {
        const row = deps.stmts.countInterruptedFinalizeRunsForSessionHead.get(
          sessionId,
          headSha,
        ) as { n: number } | undefined;
        return Number(row?.n ?? 0);
      } catch (e) {
        console.error('[finalize-boot-retrigger] count query failed', (e as Error).message);
        // Fail closed: treat as over-cap so we don't risk a crash loop.
        return Number.MAX_SAFE_INTEGER;
      }
    },
    maxGenerations,
  });

  for (const s of plan.skipped) {
    console.warn(
      `[finalize-boot-retrigger] skip session=${s.sessionId} run=${s.runId}: ${s.reason}`,
    );
  }

  const startOne = opts?.start ?? defaultStart;
  let retriggered = 0;
  for (const item of plan.retrigger) {
    try {
      const res = await startOne(deps, item);
      if (res.ok) {
        retriggered++;
        // Annotate the just-swept run so its terminal bubble self-describes the
        // auto-recovery ("superseded by an automatic re-run") instead of reading
        // as an unresolved infra failure. Best-effort: a failure here must never
        // block boot or undo the successful retrigger.
        try {
          deps.stmts.markFinalizeRunSupersededByBootRetrigger.run(item.runId);
        } catch (e) {
          console.error(
            `[finalize-boot-retrigger] supersede mark failed run=${item.runId}: ` +
              (e as Error).message,
          );
        }
        console.log(
          `[finalize-boot-retrigger] re-triggered finalize for session=${item.sessionId} ` +
            `(interrupted run=${item.runId}, new run=${res.runId})`,
        );
      } else {
        console.warn(
          `[finalize-boot-retrigger] kickoff declined session=${item.sessionId} run=${item.runId}: ` +
            `${res.error}${res.message ? ` (${res.message})` : ''}`,
        );
      }
    } catch (e) {
      console.error(
        `[finalize-boot-retrigger] kickoff threw session=${item.sessionId} run=${item.runId}: ` +
          (e as Error).message,
      );
    }
  }

  return { retriggered, skipped: plan.skipped.length };
}
