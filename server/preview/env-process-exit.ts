import type { SessionEnvExit, SessionEnvProcess } from '../session-env/session-env.js';

function splitLines(chunk: string): string[] {
  return chunk.split('\n').filter((line) => line.length > 0);
}

/**
 * Resolve once a run-to-completion process in a SessionEnv exits, teeing its
 * output line-by-line to `onLine` first.
 *
 * Shared by the dev-server build step and the apt system-deps install — both
 * spawn a short-lived command and must await its exit without leaking
 * stdout/stderr/exit subscriptions across repeated preview starts.
 *
 * The subtlety this encapsulates: `onExit` fires the callback **synchronously**
 * when the process has already exited, before it returns its unsubscribe fn. So
 * the callback disposes whatever subscriptions exist (stdout/stderr) and sets
 * `settled`; the exit subscription itself is then released based on whether the
 * callback already ran (sync/already-exited) or is still pending (async).
 */
export function waitForEnvProcessExit(
  proc: SessionEnvProcess,
  onLine?: (line: string, stream: 'stdout' | 'stderr') => void,
): Promise<SessionEnvExit> {
  return new Promise((resolve) => {
    const unsubs: Array<() => void> = [];
    let settled = false;
    const disposeAll = () => {
      for (const unsub of unsubs) {
        try {
          unsub();
        } catch {
          // A backend whose unsubscribe throws must not mask the exit.
        }
      }
      unsubs.length = 0;
    };

    if (onLine) {
      unsubs.push(
        proc.onStdout((chunk) => {
          for (const line of splitLines(chunk)) onLine(line, 'stdout');
        }),
      );
      unsubs.push(
        proc.onStderr((chunk) => {
          for (const line of splitLines(chunk)) onLine(line, 'stderr');
        }),
      );
    }

    const exitUnsub = proc.onExit((result) => {
      settled = true;
      disposeAll();
      resolve(result);
    });
    if (settled) {
      try {
        exitUnsub();
      } catch {
        // ignore — nothing left to mask.
      }
    } else {
      unsubs.push(exitUnsub);
    }
  });
}
