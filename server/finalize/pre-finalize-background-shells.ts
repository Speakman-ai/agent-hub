/**
 * pre-finalize-background-shells.ts — wait for a session's Hub-owned
 * background shells before Finalize touches the worktree, and keep the
 * watch loop from waking a new agent process while that happens.
 *
 * The failure this exists for: an agent parks pytest (or a build) in a
 * background shell, the turn ends, Auto Merge / agent-block Finalize
 * starts immediately, the shell finishes, and the watch loop injects
 * "you are now in a **new process**" into a session that already has
 * Stop Finalize on screen. The wake collides with the orchestrator;
 * CI and the leftover test fight over the same tree.
 *
 * Two halves, both required:
 *
 *   1. **Suppress wakes** as soon as kickoff begins (`forgetSession` +
 *      `disarmSessionWatch`) so a completion that lands during git
 *      probes / claim / row insert cannot dispatch a chat turn.
 *   2. **Wait** at the top of each orchestrator round until running
 *      shells exit (or the wait times out and we stop them) so rebase
 *      and CI do not start on a live pytest.
 *
 * Non-throwing contract, same as `post-push-background-shells.ts`: a
 * shell that will not die is worth a log line, never grounds to fail
 * a Finalize kickoff that is already claimed.
 */
import { randomUUID } from 'crypto';
import type { BroadcastFn, MessageRow, Stmts } from '../types.js';

/** Ceiling on how long Finalize will wait for leftover background work. */
export const PRE_FINALIZE_BACKGROUND_SHELL_WAIT_MS = 15 * 60 * 1000;

/** Poll interval while waiting. Short enough to notice Stop Finalize. */
export const PRE_FINALIZE_BACKGROUND_SHELL_POLL_MS = 250;

export type PreFinalizeShellWaitResult = 'ready' | 'timed_out' | 'aborted';

export interface PreFinalizeShellRow {
  id: string;
  session_id: string;
  status: string;
}

/** Runtime surface this module needs. Narrower than the full process owner. */
export interface PreFinalizeShellRuntime {
  listRunning?: () => PreFinalizeShellRow[];
  disarmSessionWatch?: (sessionId: string) => unknown;
  stopSessionSnapshot?: (sessionId: string) => Promise<Array<{ id: string }>>;
  stopBySessionId: (sessionId: string) => Promise<number>;
}

export interface PreFinalizeBackgroundShellDeps {
  stmts?: Pick<Stmts, 'addMessage' | 'touchSession' | 'getMessageById'>;
  broadcast?: BroadcastFn;
  getBackgroundShellRuntime?: () => PreFinalizeShellRuntime | null | undefined;
  getBackgroundShellWatcher?: () => { forgetSession: (sessionId: string) => void } | null;
  newId?: () => string;
  log?: (msg: string) => void;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

function makeSafeLog(sink: ((msg: string) => void) | undefined): (msg: string) => void {
  return (msg: string) => {
    try {
      (sink ?? console.warn)(msg);
    } catch {
      if (!sink) return;
      try {
        console.warn(msg);
      } catch {
        /* give up silently */
      }
    }
  };
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function runningShellsForSession(
  runtime: PreFinalizeShellRuntime | null | undefined,
  sessionId: string,
): PreFinalizeShellRow[] {
  if (!runtime?.listRunning) return [];
  try {
    return runtime
      .listRunning()
      .filter((row) => row.session_id === sessionId && row.status === 'running');
  } catch {
    return [];
  }
}

/**
 * Transcript line when Finalize actually has to wait. Pure so the wording
 * can be pinned without standing up the surrounding deps.
 */
export function buildPreFinalizeWaitNotice(runningCount: number): string {
  const noun = runningCount === 1 ? 'background shell' : 'background shells';
  return [
    `⏳ Finalize is waiting for ${runningCount} ${noun} to finish before starting CI.`,
    'Background work started in this session must settle first so a leftover test cannot wake a new agent process mid-run.',
  ].join('\n\n');
}

export function buildPreFinalizeWaitTimeoutNotice(stoppedCount: number): string {
  const noun = stoppedCount === 1 ? 'background shell' : 'background shells';
  return [
    `⏳ Finalize stopped waiting for background shells after ${PRE_FINALIZE_BACKGROUND_SHELL_WAIT_MS / 60_000} minutes.`,
    stoppedCount > 0
      ? `Stopped ${stoppedCount} remaining ${noun} so rebase and CI can start.`
      : 'Continuing with rebase and CI.',
  ].join('\n\n');
}

function persistNotice(
  deps: PreFinalizeBackgroundShellDeps,
  sessionId: string,
  content: string,
  metadata: Record<string, unknown>,
  log: (msg: string) => void,
): void {
  if (!deps.stmts) return;
  const messageId = (deps.newId ?? randomUUID)();
  try {
    deps.stmts.addMessage.run(
      messageId,
      sessionId,
      'system',
      content,
      null,
      null,
      null,
      JSON.stringify(metadata),
      null,
      null,
      null,
    );
  } catch (err) {
    log(
      `[pre-finalize-bg-shells] notice insert failed session=${sessionId}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return;
  }
  try {
    deps.stmts.touchSession.run(sessionId);
  } catch {
    /* best-effort */
  }
  try {
    const message = deps.stmts.getMessageById.get(messageId) as MessageRow | undefined;
    if (message && deps.broadcast) deps.broadcast({ type: 'message_added', sessionId, message });
  } catch (err) {
    log(
      `[pre-finalize-bg-shells] notice broadcast failed session=${sessionId}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

/**
 * Drop pending wakes and disarm watch on every armed shell so a completion
 * cannot spawn a new agent process. Does not kill running processes —
 * {@link waitForPreFinalizeBackgroundShells} waits for those.
 *
 * Safe to call more than once. Never throws.
 */
export function suppressBackgroundShellWakesForFinalize(
  deps: PreFinalizeBackgroundShellDeps,
  sessionId: string | null | undefined,
): void {
  const log = makeSafeLog(deps.log);
  if (!sessionId) return;
  try {
    deps.getBackgroundShellWatcher?.()?.forgetSession(sessionId);
  } catch (err) {
    log(
      `[pre-finalize-bg-shells] forgetSession failed session=${sessionId}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  try {
    deps.getBackgroundShellRuntime?.()?.disarmSessionWatch?.(sessionId);
  } catch (err) {
    log(
      `[pre-finalize-bg-shells] disarmSessionWatch failed session=${sessionId}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

/**
 * Wait until `sessionId` has no running Hub-owned background shells, the
 * abort signal fires, or {@link PRE_FINALIZE_BACKGROUND_SHELL_WAIT_MS}
 * elapses. On timeout, remaining shells are stopped so CI can take the
 * worktree. Always disarms watches first.
 *
 * Never throws.
 */
export async function waitForPreFinalizeBackgroundShells(
  deps: PreFinalizeBackgroundShellDeps,
  sessionId: string | null | undefined,
  opts?: { signal?: { aborted: boolean }; timeoutMs?: number; pollMs?: number },
): Promise<PreFinalizeShellWaitResult> {
  const log = makeSafeLog(deps.log);
  if (!sessionId) return 'ready';

  suppressBackgroundShellWakesForFinalize(deps, sessionId);

  let runtime: PreFinalizeShellRuntime | null | undefined;
  try {
    runtime = deps.getBackgroundShellRuntime?.();
  } catch (err) {
    log(
      `[pre-finalize-bg-shells] runtime lookup failed session=${sessionId}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return 'ready';
  }
  if (!runtime) return 'ready';

  const timeoutMs = opts?.timeoutMs ?? PRE_FINALIZE_BACKGROUND_SHELL_WAIT_MS;
  const pollMs = opts?.pollMs ?? PRE_FINALIZE_BACKGROUND_SHELL_POLL_MS;
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? defaultSleep;
  const startedAt = now();

  const running = (): PreFinalizeShellRow[] => runningShellsForSession(runtime, sessionId);

  if (opts?.signal?.aborted) return 'aborted';

  const initial = running();
  if (initial.length === 0) return 'ready';

  persistNotice(
    deps,
    sessionId,
    buildPreFinalizeWaitNotice(initial.length),
    {
      kind: 'background_shell_finalize_wait',
      runningCount: initial.length,
    },
    log,
  );

  log(`[pre-finalize-bg-shells] waiting for ${initial.length} shell(s) session=${sessionId}`);

  while (running().length > 0) {
    if (opts?.signal?.aborted) return 'aborted';
    if (now() - startedAt >= timeoutMs) {
      let stopped = 0;
      try {
        if (runtime.stopSessionSnapshot) {
          stopped = (await runtime.stopSessionSnapshot(sessionId)).length;
        } else {
          stopped = await runtime.stopBySessionId(sessionId);
        }
      } catch (err) {
        log(
          `[pre-finalize-bg-shells] timeout stop failed session=${sessionId}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
      persistNotice(
        deps,
        sessionId,
        buildPreFinalizeWaitTimeoutNotice(stopped),
        {
          kind: 'background_shell_finalize_wait_timeout',
          stoppedCount: stopped,
        },
        log,
      );
      log(`[pre-finalize-bg-shells] timed out session=${sessionId} stopped=${stopped}`);
      return 'timed_out';
    }
    await sleep(pollMs);
  }

  return 'ready';
}
