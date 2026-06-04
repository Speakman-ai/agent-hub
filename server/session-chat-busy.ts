import type { ActiveTaskRow, Stmts } from './types.js';

/**
 * True when `pid` refers to a live process on this host. Used to detect stale
 * `active_tasks` rows left behind when a CLI child exited without clearing the
 * DB row (the root cause of autofix messages stuck in `queued` forever).
 */
export function isPidAlive(pid: number | null | undefined): boolean {
  if (pid == null || !Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EPERM') return true;
    return false;
  }
}

/**
 * Whether a session currently has in-flight chat work. Prefer in-memory process /
 * delegation markers; fall back to `active_tasks` only when the row still
 * represents a live run (running status + live pid, or a pre-spawn window with
 * no pid yet).
 */
export function isSessionChatBusy(
  sessionId: string,
  activeProcesses: ReadonlyMap<string, unknown>,
  activeDelegationSessions: ReadonlySet<string>,
  activeTask?: ActiveTaskRow | undefined,
): boolean {
  if (activeProcesses.has(sessionId)) return true;
  if (activeDelegationSessions.has(sessionId)) return true;
  if (!activeTask) return false;
  if (activeTask.status && activeTask.status !== 'running') return false;
  if (activeTask.pid != null) return isPidAlive(activeTask.pid);
  return true;
}

export type QueueDrainPollEvent = 'attempt' | 'skipped_busy';

/** Greppable poll/boot drain line (failure-mode B observability). */
export function logQueueDrainPoll(
  event: QueueDrainPollEvent,
  sessionId: string,
  queuedCount: number,
): void {
  console.log(`[QueueDrain] event=${event} session=${sessionId} queued=${queuedCount}`);
}

export interface DrainIdleQueuedSessionsArgs {
  stmts: Pick<Stmts, 'getAllQueuedSessions' | 'getActiveTask' | 'getQueuedMessages'>;
  activeProcesses: ReadonlyMap<string, unknown>;
  activeDelegationSessions: ReadonlySet<string>;
  drainQueue: (sessionId: string) => void;
}

/**
 * For every session with rows in `message_queue`, call `drainQueue` when the
 * session is not actually busy. Safe to run on boot and from any periodic
 * sweep.
 */
export function drainIdleQueuedSessions(args: DrainIdleQueuedSessionsArgs): number {
  let attempts = 0;
  const sessions = args.stmts.getAllQueuedSessions.all() as Array<{ session_id: string }>;
  for (const { session_id } of sessions) {
    const queue = args.stmts.getQueuedMessages.all(session_id);
    const queuedCount = Array.isArray(queue) ? queue.length : 0;
    if (queuedCount === 0) continue;

    const task = args.stmts.getActiveTask.get(session_id) as ActiveTaskRow | undefined;
    if (isSessionChatBusy(session_id, args.activeProcesses, args.activeDelegationSessions, task)) {
      logQueueDrainPoll('skipped_busy', session_id, queuedCount);
      continue;
    }

    logQueueDrainPoll('attempt', session_id, queuedCount);
    args.drainQueue(session_id);
    attempts++;
  }
  return attempts;
}
