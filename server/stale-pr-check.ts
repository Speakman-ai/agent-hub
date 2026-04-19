/**
 * Periodic sweeper for sessions stuck in "changes awaiting PR creation".
 *
 * When an ad-hoc session ends with uncommitted/unpushed work and no open PR,
 * `auto-git.ts` stores a JSON blob in `sessions.changes_ready` and broadcasts
 * a one-shot `changes_ready` event (bridged to push). If the user ignores the
 * banner for a while, the work sits in limbo — there's no reminder.
 *
 * This module wakes up every `STALE_PR_CHECK_INTERVAL_MS` and dispatches a
 * `pr_creation_stale` push for any session whose `updated_at` is older than
 * `STALE_PR_THRESHOLD_MS` and that hasn't been notified yet (dedup via
 * `sessions.stale_pr_notified_at`, cleared when `changes_ready` is cleared so
 * a future stale period re-fires).
 *
 * Both constants are hardcoded here rather than pulled from `config.json` —
 * easy to promote to runtime config later if the product wants it tunable.
 */
import type { Stmts } from './types.js';
import { dispatchPushEvent, prCreationStalePush, type PushDispatchDeps } from './push.js';

// ── Tunables (module-level exports so tests can read the same values) ──
export const STALE_PR_THRESHOLD_MS = 30 * 60 * 1000;
export const STALE_PR_CHECK_INTERVAL_MS = 5 * 60 * 1000;

// ── Shape of a row returned by stmts.getStalePendingPrSessions ─────────
interface StalePendingPrRow {
  id: string;
  name: string | null;
  agent_id: string;
  changes_ready: string | null;
  updated_at: string;
}

export interface StalePrCheckDeps {
  stmts: Pick<Stmts, 'getStalePendingPrSessions' | 'markStalePrNotified'>;
  /**
   * Optional WebSocket broadcast hook. When provided, we also emit a
   * `pr_creation_stale` broadcast so web/desktop clients can refresh a
   * banner. Mobile clients get the push regardless.
   */
  broadcast?: (data: Record<string, unknown>) => void;
  /**
   * Resolve an agent id to its `{ name, projectId }`. Used to enrich the
   * push payload. Absence is tolerated (we fall back to the session name).
   */
  getAgent?: (agentId: string) => { name?: string; projectId?: string | null } | null;
  /** Override current time for deterministic tests. */
  now?: () => number;
  /** Passed through to `dispatchPushEvent` (injectable fetch + token store). */
  pushDeps?: PushDispatchDeps;
  /** Override for tests to silence console noise. */
  log?: (msg: string) => void;
}

interface ParsedChangesReady {
  branch?: string;
}

function parseChangesReady(raw: string | null): ParsedChangesReady {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object' && 'branch' in parsed) {
      const branch = (parsed as { branch?: unknown }).branch;
      if (typeof branch === 'string') return { branch };
    }
    return {};
  } catch {
    return {};
  }
}

/**
 * SQLite's `datetime('now')` stamps use UTC with no 'Z' suffix, so
 * `new Date(updatedAt).getTime()` parses them as local time on some runtimes.
 * Appending 'Z' forces UTC parsing and keeps the age calculation correct.
 */
function ageMsFromSqliteTimestamp(updatedAt: string, now: number): number {
  const s = /Z|[+-]\d{2}:?\d{2}$/.test(updatedAt) ? updatedAt : updatedAt.replace(' ', 'T') + 'Z';
  const t = Date.parse(s);
  if (Number.isNaN(t)) return 0;
  return Math.max(0, now - t);
}

/**
 * One pass of the stale-pending-PR sweep. Dispatches a push + optional
 * broadcast for each session whose `updated_at` exceeds the threshold,
 * then marks each as notified so it won't fire again on the next pass.
 *
 * Returns the number of notifications dispatched (useful for tests).
 * Non-throwing: per-row errors are logged and the sweep continues.
 */
export async function runStalePrCheck(deps: StalePrCheckDeps): Promise<number> {
  const now = deps.now ? deps.now() : Date.now();
  const log = deps.log ?? ((msg: string) => console.error(msg));

  let rows: StalePendingPrRow[];
  try {
    rows = deps.stmts.getStalePendingPrSessions.all() as StalePendingPrRow[];
  } catch (err) {
    log(`[stale-pr-check] Failed to query sessions: ${(err as Error).message}`);
    return 0;
  }

  let dispatched = 0;
  for (const row of rows) {
    try {
      const { branch } = parseChangesReady(row.changes_ready);
      const agentInfo = deps.getAgent?.(row.agent_id) ?? null;
      const agentName = agentInfo?.name;
      const projectId = agentInfo?.projectId ?? null;
      const ageMinutes = Math.round(ageMsFromSqliteTimestamp(row.updated_at, now) / 60000);
      const { title, body } = prCreationStalePush({
        agentName,
        sessionName: row.name ?? undefined,
        branch,
        ageMinutes,
      });

      await dispatchPushEvent(
        'pr_creation_stale',
        {
          title,
          body,
          data: {
            type: 'pr_creation_stale',
            sessionId: row.id,
            agentId: row.agent_id,
            projectId,
            branch,
          },
        },
        deps.pushDeps,
      );

      deps.broadcast?.({
        type: 'pr_creation_stale',
        sessionId: row.id,
        agentId: row.agent_id,
        agentName,
        sessionName: row.name,
        projectId,
        branch,
        ageMinutes,
      });

      deps.stmts.markStalePrNotified.run(row.id);
      dispatched += 1;
    } catch (err) {
      log(`[stale-pr-check] Failed for session ${row.id}: ${(err as Error).message}`);
    }
  }

  return dispatched;
}

/**
 * Launch the periodic checker. The first run is scheduled one interval
 * ahead — at server start there's nothing stale yet, and we don't want to
 * block startup waiting on the Expo HTTP call.
 */
export function startStalePrChecker(
  deps: StalePrCheckDeps,
  intervalMs: number = STALE_PR_CHECK_INTERVAL_MS,
): () => void {
  const timer = setInterval(() => {
    runStalePrCheck(deps).catch((err) => {
      const log = deps.log ?? ((msg: string) => console.error(msg));
      log(`[stale-pr-check] sweep failed: ${(err as Error).message}`);
    });
  }, intervalMs);
  // Don't keep the event loop alive just for this timer.
  if (typeof timer.unref === 'function') timer.unref();
  return () => clearInterval(timer);
}
