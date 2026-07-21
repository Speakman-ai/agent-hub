/**
 * autonomous-start-schedule.ts — node-cron registration + firing for SCHEDULED
 * EPIC STARTS. An epic may carry a single optional schedule
 * (`scheduled_start_cron` + `scheduled_start_timezone` + `scheduled_start_enabled`
 * + `scheduled_start_enabled_by` on `kanban_epics`). When it fires, the epic's
 * phases start left-to-right via {@link startAutonomousEpicChain}, honoring each
 * phase's auto-dispatch arming (the sweep halts at the first disabled phase).
 *
 * Mirrors the deploy scheduler / crons / heartbeats pattern exactly:
 *   - one node-cron task per enabled schedule, keyed by epic id;
 *   - the cron expression is interpreted in the schedule's IANA timezone
 *     (null = server scheduler default — local server time);
 *   - the run executes under the owner identity (`scheduled_start_enabled_by`)
 *     so spawn credentials resolve to whoever armed the schedule;
 *   - a disabled schedule is a retained pause (registers nothing);
 *   - every failure is logged and swallowed so one bad schedule can never take
 *     down the scheduler or crash a tick.
 *
 * Gating on each tick re-reads the epic row (the DB is the source of truth): a
 * schedule flipped off / cleared between the minute boundary and the tick must
 * not fire, and the owner must still resolve or the run is skipped (the same
 * credential-owner rule the epic-start route and per-phase run enforce).
 */
import cron, { type ScheduledTask } from 'node-cron';
import { defaultTickOptions, estimateIntervalSeconds, wrapCronTick } from './cron-tick.js';
import { getStmts } from './db.js';
import { getOrCreateBoard } from './routes/board.js';
import { startAutonomousEpicChain as defaultStartEpicChain } from './autonomous.js';
import type { KanbanEpicRow, Project, Stmts } from './types.js';

export interface EpicStartScheduleTickerDeps {
  /** All projects — iterated at boot to resolve each board's scheduled epics. */
  getProjects: () => Project[];
  /** Test seam — defaults to the shared prepared-statements singleton. */
  stmts?: Stmts;
  /** Test seam — defaults to {@link defaultStartEpicChain}. */
  startEpicChain?: typeof defaultStartEpicChain;
  /** Test seam — the node-cron scheduler. Defaults to {@link cron.schedule}. */
  scheduleFn?: typeof cron.schedule;
  /** Override for tests to capture log lines. */
  log?: (msg: string) => void;
}

// ─── Module-level state ────────────────────────────────────────────────────
/**
 * `${projectId}:${epicId}` → running node-cron task. Epic ids are only unique
 * within a project/board, so the map MUST be keyed by a project-qualified id —
 * keying by bare epic id would let one project's schedule stop/replace another
 * project's schedule for a colliding epic id.
 */
const scheduleTasks = new Map<string, { task: ScheduledTask; projectId: string; epicId: string }>();

/** Project-qualified registry key for an epic's schedule. */
function scheduleKey(projectId: string, epicId: string): string {
  return `${projectId}:${epicId}`;
}

/** Injected deps (set via {@link initEpicStartSchedules}). */
let tickerDeps: EpicStartScheduleTickerDeps | null = null;

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function defaultLog(msg: string): void {
  console.log(msg);
}

function stmtsOf(deps: EpicStartScheduleTickerDeps): Stmts {
  return deps.stmts ?? getStmts();
}

/**
 * Fire a single schedule: re-read the epic, confirm it is still enabled with a
 * resolvable owner, and start its phase sweep under the owner identity. Never
 * rejects — every failure is logged and swallowed. Exported for tests.
 */
export async function runScheduledEpicStart(
  projectId: string,
  epicId: string,
  deps: EpicStartScheduleTickerDeps,
): Promise<void> {
  const stmts = stmtsOf(deps);
  const startEpicChain = deps.startEpicChain ?? defaultStartEpicChain;
  const log = deps.log ?? defaultLog;

  // Re-read: the task is stopped when a schedule flips off / is cleared, but a
  // tick already queued can still run against a stale snapshot. The DB row is
  // the source of truth for enabled + cron + owner.
  const epic = stmts.getKanbanEpic.get(epicId) as KanbanEpicRow | undefined;
  if (!epic || epic.scheduled_start_enabled !== 1 || !epic.scheduled_start_cron) return;

  const label = `${projectId} epic "${epic.name}" (${epicId})`;
  const owner = epic.scheduled_start_enabled_by ?? null;
  if (!owner) {
    log(`[epic-start-schedule] ${label}: no resolvable owner for credentials — skipped`);
    return;
  }

  try {
    const result = await startEpicChain(projectId, epicId, owner);
    log(
      `[epic-start-schedule] ${label} → ${result.outcome}${
        result.phaseName ? ` (phase "${result.phaseName}")` : ''
      }`,
    );
  } catch (err) {
    log(`[epic-start-schedule] ${label}: start failed: ${errMessage(err)}`);
  }
}

/** Stop and drop the running task for a project-qualified key (if any). */
function stopTask(key: string): void {
  const existing = scheduleTasks.get(key);
  if (existing) {
    existing.task.stop();
    scheduleTasks.delete(key);
  }
}

/**
 * (Re)register a node-cron task for an epic's schedule. A disabled / cron-less
 * epic stops any running task and registers nothing (a retained pause).
 */
function registerEpicSchedule(
  projectId: string,
  epic: KanbanEpicRow,
  deps: EpicStartScheduleTickerDeps,
): void {
  const key = scheduleKey(projectId, epic.id);
  stopTask(key);
  if (epic.scheduled_start_enabled !== 1 || !epic.scheduled_start_cron) return;

  const scheduleFn = deps.scheduleFn ?? cron.schedule;
  const name = `epic-start-schedule:${projectId}:${epic.id}`;
  const cronExpr = epic.scheduled_start_cron;
  const task = scheduleFn(
    cronExpr,
    wrapCronTick(
      () =>
        runScheduledEpicStart(projectId, epic.id, deps).catch((err: unknown) => {
          console.error(`[epic-start-schedule] ${name} tick error:`, errMessage(err));
        }),
      name,
    ),
    defaultTickOptions({
      intervalSeconds: estimateIntervalSeconds(cronExpr),
      timezone: epic.scheduled_start_timezone ?? undefined,
      name,
    }),
  );
  scheduleTasks.set(key, { task, projectId, epicId: epic.id });
}

/**
 * Register every enabled epic-start schedule at boot and stash deps so the CRUD
 * route can refresh individual registrations without re-plumbing. Idempotent:
 * clears existing tasks first, so a re-init re-syncs cleanly.
 */
export function initEpicStartSchedules(deps: EpicStartScheduleTickerDeps): void {
  tickerDeps = deps;
  for (const key of [...scheduleTasks.keys()]) stopTask(key);

  const stmts = stmtsOf(deps);
  let count = 0;
  for (const project of deps.getProjects()) {
    try {
      const boardData = getOrCreateBoard(stmts, project.id);
      if (!boardData?.board) continue;
      const epics = stmts.getStartScheduledEpicsByBoard.all(boardData.board.id) as KanbanEpicRow[];
      for (const epic of epics) {
        try {
          registerEpicSchedule(project.id, epic, deps);
          count += 1;
        } catch (err) {
          console.error(
            `[epic-start-schedule] failed to register ${project.id}/${epic.id}:`,
            errMessage(err),
          );
        }
      }
    } catch (err) {
      console.error(
        `[epic-start-schedule] failed to scan project "${project.id}":`,
        errMessage(err),
      );
    }
  }
  if (count > 0) {
    console.log(`[epic-start-schedule] registered ${count} enabled schedule(s) on boot`);
  }
}

/**
 * Re-sync one epic's node-cron registration from the DB row. Called by the CRUD
 * route after a create / update / clear so a new or edited schedule takes effect
 * immediately without a restart. No-op before {@link initEpicStartSchedules}.
 */
export function refreshEpicStartScheduleRegistration(projectId: string, epicId: string): void {
  if (!tickerDeps) return;
  const stmts = stmtsOf(tickerDeps);
  const epic = stmts.getKanbanEpic.get(epicId) as KanbanEpicRow | undefined;
  if (!epic) {
    stopTask(scheduleKey(projectId, epicId));
    return;
  }
  try {
    registerEpicSchedule(projectId, epic, tickerDeps);
  } catch (err) {
    console.error(
      `[epic-start-schedule] failed to refresh ${projectId}/${epicId}:`,
      errMessage(err),
    );
  }
}

/** Stop and drop an epic's task — called when an epic is deleted. */
export function unregisterEpicStartSchedule(projectId: string, epicId: string): void {
  stopTask(scheduleKey(projectId, epicId));
}

/** Test/shutdown helper: stop every registered task and clear injected deps. */
export function stopAllEpicStartSchedules(): void {
  for (const key of [...scheduleTasks.keys()]) stopTask(key);
  tickerDeps = null;
}

/**
 * Test introspection: project-qualified registry keys (`${projectId}:${epicId}`)
 * with a live node-cron task.
 */
export function getRegisteredEpicStartScheduleIds(): string[] {
  return [...scheduleTasks.keys()];
}
