/**
 * scheduled-scan.ts — periodic dependency security re-scan for Hub-hosted
 * projects, modelled on stale-pr-check.ts.
 *
 * Opt-in per project via `Project.securityScan.schedule` (`daily` | `weekly`;
 * `off`/unset = no scheduled scan). A single low-frequency ticker wakes every
 * {@link SCHEDULED_SCAN_TICK_MS} and, for each enrolled project whose last
 * scheduled scan is older than its cadence, runs `runSecurityScan` against the
 * default-branch tip.
 *
 * Suppressions are respected by the store, and runSecurityScan opens a kanban
 * card ONLY when the scan surfaces new/reopened findings — so a quiet project
 * re-scanned daily produces no churn. Each scan is best-effort: a failure
 * (empty repo, OSV blip) is logged and the sweep continues to the next project.
 *
 * Last-run state is in-memory (a Map keyed by project id). Losing it across a
 * restart only means an enrolled project gets one extra scan shortly after
 * boot — harmless at daily/weekly cadence, and the no-card-when-clean rule
 * keeps it noise-free. Persisting it wasn't worth a schema column.
 */

import type { BroadcastFn, Project, Stmts } from '../types.js';
import type { AdvisorySource } from './types.js';
import { OsvAdvisorySource } from './osv.js';
import { runSecurityScan } from './run.js';

export type SecurityScanSchedule = 'off' | 'daily' | 'weekly';

/** Cadence per schedule. A scan runs when `now - lastRun >= cadence`. */
export const SCHEDULE_INTERVALS_MS: Record<Exclude<SecurityScanSchedule, 'off'>, number> = {
  daily: 24 * 60 * 60 * 1000,
  weekly: 7 * 24 * 60 * 60 * 1000,
};

/** How often the ticker wakes to look for due projects (hourly). */
export const SCHEDULED_SCAN_TICK_MS = 60 * 60 * 1000;

/** Module-level last-run state, shared across ticks. Tests inject their own. */
const moduleLastRunAt = new Map<string, number>();

export interface ScheduledSecurityScanDeps {
  stmts: Stmts;
  broadcast: BroadcastFn;
  /** Resolve the current project list (live config, not a snapshot). */
  getProjects: () => Project[];
  /** Advisory source. Defaults to OSV over the network. */
  advisorySource?: AdvisorySource;
  /** Test seam — defaults to {@link runSecurityScan}. */
  runScan?: typeof runSecurityScan;
  /** Clock seam (tests). */
  now?: () => number;
  /** Last-run state. Defaults to a shared module-level map. */
  lastRunAt?: Map<string, number>;
  dataDir?: string;
  /** Override for tests to silence console noise. */
  log?: (msg: string) => void;
}

function normalizeSchedule(value: unknown): Exclude<SecurityScanSchedule, 'off'> | null {
  return value === 'daily' || value === 'weekly' ? value : null;
}

/**
 * One sweep: scan every enrolled Hub-hosted project whose cadence has elapsed.
 * Returns the number of scans dispatched (useful for tests). Non-throwing —
 * a per-project failure is logged and the sweep continues.
 */
export async function runScheduledSecurityScans(deps: ScheduledSecurityScanDeps): Promise<number> {
  const now = deps.now ? deps.now() : Date.now();
  const lastRunAt = deps.lastRunAt ?? moduleLastRunAt;
  const runScan = deps.runScan ?? runSecurityScan;
  const log = deps.log ?? ((msg: string) => console.log(msg));

  let projects: Project[];
  try {
    projects = deps.getProjects();
  } catch (err) {
    log(`[security-schedule] failed to list projects: ${(err as Error).message}`);
    return 0;
  }

  // Build the advisory source once per sweep (cheap, but avoids reconstructing
  // it per project) and reuse it across every scan this pass.
  const advisorySource = deps.advisorySource ?? new OsvAdvisorySource();

  let dispatched = 0;
  for (const project of projects) {
    const schedule = normalizeSchedule(project.securityScan?.schedule);
    if (!schedule) continue;
    if (project.gitHost !== 'agenthub') continue;

    const cadence = SCHEDULE_INTERVALS_MS[schedule];
    const last = lastRunAt.get(project.id);
    if (last !== undefined && now - last < cadence) continue;

    // Claim the slot BEFORE awaiting so two overlapping ticks can't double-fire
    // the same project (the scan itself is also serialized per project inside
    // runSecurityScan). A transient failure simply waits one cadence to retry.
    lastRunAt.set(project.id, now);
    try {
      const result = await runScan(
        {
          stmts: deps.stmts,
          broadcast: deps.broadcast,
          advisorySource,
          dataDir: deps.dataDir,
        },
        { project, generateCard: true, createdBy: null },
      );
      dispatched += 1;
      if (
        !result.dryRun &&
        result.summary.newFindings.length + result.summary.reopenedFindings.length > 0
      ) {
        log(
          `[security-schedule] ${project.id} (${schedule}): ${result.summary.newFindings.length} new, ` +
            `${result.summary.reopenedFindings.length} reopened${
              result.cardId ? ` → card ${result.cardId}` : ''
            }`,
        );
      }
    } catch (err: unknown) {
      log(
        `[security-schedule] scan failed for ${project.id}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  return dispatched;
}

/**
 * Launch the periodic scheduled-scan ticker. Returns a stop function. The timer
 * is `unref`'d so it never keeps the event loop alive on its own.
 */
export function startScheduledSecurityScanner(
  deps: ScheduledSecurityScanDeps,
  intervalMs: number = SCHEDULED_SCAN_TICK_MS,
): () => void {
  const timer = setInterval(() => {
    runScheduledSecurityScans(deps).catch((err) => {
      const log = deps.log ?? ((msg: string) => console.error(msg));
      log(`[security-schedule] sweep failed: ${(err as Error).message}`);
    });
  }, intervalMs);
  if (typeof timer.unref === 'function') timer.unref();
  return () => clearInterval(timer);
}

/** Test seam: clear the shared last-run state between tests. */
export function __resetScheduledSecurityScanState(): void {
  moduleLastRunAt.clear();
}
