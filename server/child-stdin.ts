import type { ChildProcess } from 'child_process';

/**
 * Broken-pipe-safe stdin writes for spawned CLI engines.
 *
 * `proc.stdin.end(prompt)` on a pipe is asynchronous: once the payload
 * exceeds the kernel pipe buffer (~64 KB) the remainder stays queued until
 * the child reads it. If the child goes away first — a CLI that dies on a
 * quota / API error before touching its prompt, or one the Hub SIGTERMs on a
 * turn timeout — the queued write fails with `EPIPE`. Node reports that as an
 * `'error'` event on the stdin socket, *not* as a synchronous throw, so a
 * `try { stdin.end() } catch {}` never sees it. With no `'error'` listener the
 * event machinery rethrows it as an uncaught exception and the whole server
 * exits.
 *
 * That is exactly what took prod down on 2026-09-17: nineteen crash-restarts in
 * one day, each one a ~520 KB grok-cli reviewer corpus still in flight when the
 * reviewer-turn timeout killed the child.
 *
 * Every site that pipes anything into a child's stdin goes through here.
 */

const guarded = new WeakSet<object>();

/** Error codes that just mean "the child stopped reading" — expected, not a bug. */
const BENIGN_CODES = new Set(['EPIPE', 'ERR_STREAM_DESTROYED', 'ECONNRESET']);

function errorCode(err: unknown): string {
  return (err as { code?: string } | null)?.code ?? 'unknown';
}

/**
 * Attach a one-time `'error'` handler to `proc.stdin` so a broken pipe is
 * logged instead of crashing the process. Safe to call repeatedly.
 */
export function guardChildStdin(proc: Pick<ChildProcess, 'stdin'>, label: string): void {
  const stdin = proc.stdin;
  // Tolerate partial stdin doubles (tests hand routes a bare `{ write }`).
  if (!stdin || typeof stdin.on !== 'function' || guarded.has(stdin)) return;
  guarded.add(stdin);
  stdin.on('error', (err: unknown) => {
    const code = errorCode(err);
    if (BENIGN_CODES.has(code)) {
      console.warn(
        `[child-stdin] ${label}: stdin write failed (${code}) — child exited before reading its input`,
      );
      return;
    }
    console.error(
      `[child-stdin] ${label}: unexpected stdin error (${code}):`,
      err instanceof Error ? err.message : err,
    );
  });
}

/**
 * Write `payload` to the child's stdin and close it, absorbing a broken pipe.
 * Returns false when nothing could be written (no stdin, or a synchronous
 * failure) so callers that care can log/handle it.
 */
export function endChildStdin(
  proc: Pick<ChildProcess, 'stdin'>,
  payload: string,
  label: string,
): boolean {
  const stdin = proc.stdin;
  if (!stdin) return false;
  guardChildStdin(proc, label);
  try {
    stdin.end(payload, 'utf8');
    return true;
  } catch (err) {
    console.error(
      `[child-stdin] ${label}: failed to write stdin payload:`,
      err instanceof Error ? err.message : err,
    );
    return false;
  }
}
