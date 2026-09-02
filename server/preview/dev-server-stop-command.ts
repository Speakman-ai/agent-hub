/**
 * Dev-server teardown step.
 *
 * `prEnv.devServer.stopCommand` names an optional command the Hub runs on
 * every teardown path (manual stop, idle reap, restart, failed-start
 * rollback). It exists to clean up resources the tracked process does not
 * own — chiefly the containers a `docker compose up` start command leaves
 * behind. The compose CLI is a child of the Hub, but the containers it
 * starts are children of the Docker daemon, so signalling the CLI leaves
 * them running and holding their published host ports. `docker compose down
 * --remove-orphans` as the stop command removes them.
 *
 * Runs inside the same SessionEnv with the same env + resolved secrets the
 * dev server got, so a compose project namespaced by an env var (e.g.
 * `COMPOSE_PROJECT_NAME` / `AGENT_HUB_SESSION_ID`) tears down the same
 * project it started. Best-effort: a non-zero exit, a spawn failure, or a
 * timeout is reported and swallowed — teardown must not wedge on cleanup.
 */

import type { SessionEnv, SessionEnvExit } from '../session-env/session-env.js';
import { waitForEnvProcessExit } from './env-process-exit.js';

/** Stream label used for stop-command log lines in the preview log tail. */
export const STOP_PROCESS_NAME = 'stop';

/** Compose down of a multi-service stack can take a while; 2 min is generous. */
export const DEFAULT_STOP_COMMAND_TIMEOUT_MS = 120_000;

export interface RunDevServerStopCommandOpts {
  env: SessionEnv;
  /** Shell command run via `sh -c`. Already trimmed/validated upstream. */
  stopCommand: string;
  /** Working directory relative to the worktree root (matches `startCommand`). */
  cwd?: string;
  /** Same env + resolved secrets the dev server gets. */
  spawnEnv?: Record<string, string>;
  /** Per-line sink so callers can tee stop output into the preview log tail. */
  onLine?: (line: string, stream: 'stdout' | 'stderr') => void;
  /** Kill the command and give up after this many ms. */
  timeoutMs?: number;
  /** Injected in tests; real callers use the default `setTimeout`. */
  setTimeoutFn?: (cb: () => void, ms: number) => { unref?: () => void };
  clearTimeoutFn?: (handle: unknown) => void;
}

export interface RunDevServerStopCommandResult {
  exit: SessionEnvExit;
  /** True when the timeout fired and the command was killed mid-run. */
  timedOut: boolean;
}

/**
 * Run `stopCommand` to completion in `env` and resolve with its exit. Never
 * throws: a spawn failure resolves as an errored exit, and a run that exceeds
 * `timeoutMs` is killed and reported with `timedOut: true`. The caller decides
 * how to log the outcome; teardown proceeds regardless.
 */
export async function runDevServerStopCommand(
  opts: RunDevServerStopCommandOpts,
): Promise<RunDevServerStopCommandResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_STOP_COMMAND_TIMEOUT_MS;
  opts.onLine?.(`[${STOP_PROCESS_NAME}] running: ${opts.stopCommand}`, 'stdout');

  let proc;
  try {
    proc = opts.env.spawn(opts.stopCommand, {
      cwd: opts.cwd,
      env: opts.spawnEnv,
      name: `dev-server-stop:${opts.env.sessionId}`,
    });
  } catch (err) {
    return { exit: { code: null, signal: null, error: err as Error }, timedOut: false };
  }

  const setTimeoutFn = opts.setTimeoutFn ?? ((cb, ms) => setTimeout(cb, ms));
  const clearTimeoutFn =
    opts.clearTimeoutFn ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));

  // Bound the wait by *racing* the process exit against the timeout, rather
  // than only scheduling a kill and then awaiting the exit unconditionally.
  // A `kill()` that throws, or a backend that never emits an exit after the
  // kill, must not leave this promise (and therefore `stop()`) wedged past the
  // configured bound — teardown is best-effort, so it returns regardless.
  let timeoutHandle: { unref?: () => void } | undefined;
  const timeoutPromise = new Promise<RunDevServerStopCommandResult>((resolve) => {
    timeoutHandle = setTimeoutFn(() => {
      // SIGKILL: a compose down that has itself wedged will not honor SIGTERM,
      // and the port is about to be reclaimed regardless.
      try {
        proc.kill('SIGKILL');
      } catch {
        // Already gone, or the backend's kill throws — we resolve anyway so
        // the bound is honored.
      }
      resolve({ exit: { code: null, signal: 'SIGKILL' }, timedOut: true });
    }, timeoutMs);
    // Never keep the event loop alive for a cleanup timer.
    timeoutHandle.unref?.();
  });

  const exitPromise = waitForEnvProcessExit(proc, opts.onLine).then(
    (exit): RunDevServerStopCommandResult => ({ exit, timedOut: false }),
  );

  const result = await Promise.race([exitPromise, timeoutPromise]);
  clearTimeoutFn(timeoutHandle);
  return result;
}

/** Human-readable summary of a stop-command outcome for the log. */
export function describeStopExit(result: RunDevServerStopCommandResult): string {
  if (result.timedOut) return 'stopCommand timed out and was killed';
  const { exit } = result;
  if (exit.error) return `stopCommand failed to spawn: ${exit.error.message}`;
  if (exit.signal) return `stopCommand killed by signal ${exit.signal}`;
  if (exit.code && exit.code !== 0) return `stopCommand exited with code ${exit.code}`;
  return 'stopCommand completed';
}
