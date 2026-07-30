/**
 * Spawned-child process-group registry and shutdown handler.
 *
 * Background: Agent Hub spawns long-running CLI children (claude, cursor-agent,
 * codex). Each of those can spawn its own subtree (bash → npm → vitest → workers,
 * etc). When the agent-hub server itself is killed (pm2 max_memory_restart, OOM,
 * crash, or normal shutdown), the kernel reparents those children to PID 1 and
 * they keep running — orphan claudes have appeared running `find / -name '*.env'`
 * and `npm exec vitest` long after the server died, eating CPU and memory.
 *
 * Fix:
 *   1. spawn() every CLI child with `detached: true` so each child becomes
 *      the leader of its own process group (pgid == child pid).
 *   2. Track the child here via `trackChild(proc)`.
 *   3. On server SIGTERM/SIGINT, signal every tracked group (including
 *      grandchildren) and force-kill survivors after a grace period.
 *   4. User-initiated cancel paths (handleCancel, timeouts)
 *      use `killProcessGroup(proc)` instead of `proc.kill()` so the signal
 *      reaches the full subtree, not just the top-level child.
 */
import type { ChildProcess } from 'child_process';

const tracked = new Set<ChildProcess>();
let handlersInstalled = false;
let shuttingDown = false;

/** Track a spawned child so it can be killed on server shutdown. Auto-removes on exit/close. */
export function trackChild(proc: ChildProcess): void {
  if (!proc.pid) return;
  tracked.add(proc);
  const cleanup = (): void => {
    tracked.delete(proc);
  };
  proc.once('close', cleanup);
  proc.once('exit', cleanup);
}

/**
 * Send `signal` to the entire process group led by `proc`. Requires the child
 * to have been spawned with `detached: true` so its pgid == its pid. If the
 * group lookup fails (ESRCH — child not detached, or already gone), falls back
 * to a direct `proc.kill(signal)` so single-process kills still work.
 */
export function killProcessGroup(
  proc: ChildProcess | { pid?: number | null } | null | undefined,
  signal: NodeJS.Signals = 'SIGTERM',
): void {
  if (!proc || !proc.pid) return;
  try {
    process.kill(-proc.pid, signal);
    return;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ESRCH' && code !== 'EPERM') return;
  }
  try {
    (proc as ChildProcess).kill?.(signal);
  } catch {
    /* already dead */
  }
}

/**
 * SIGTERM every tracked child's process group, then SIGKILL any survivor after
 * `graceMs`. Returned promise resolves once the SIGKILL pass has fired (so
 * shutdown code can `await` it before exiting).
 */
export function killAllTrackedProcessGroups(graceMs = 5000): Promise<void> {
  const procs = Array.from(tracked);
  for (const proc of procs) {
    killProcessGroup(proc, 'SIGTERM');
  }
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      for (const proc of procs) {
        if (tracked.has(proc)) killProcessGroup(proc, 'SIGKILL');
      }
      resolve();
    }, graceMs);
    timer.unref();
  });
}

/**
 * Install SIGTERM/SIGINT handlers that drain all tracked process groups before
 * the server exits. Idempotent — safe to call from multiple init sites. Runs
 * alongside any other handlers (e.g. claude-auth.ts's login-proc cleanup);
 * Node fires every registered handler on a signal.
 */
export function installShutdownHandlers(graceMs = 5000): void {
  if (handlersInstalled) return;
  handlersInstalled = true;
  const handler = (signal: NodeJS.Signals): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    const n = tracked.size;
    if (n > 0) {
      console.log(`[shutdown] ${signal} received, draining ${n} child process group(s)`);
    }
    killAllTrackedProcessGroups(graceMs).then(() => {
      // NOTE: this hard-exits once the drain finishes. If other async shutdown
      // work is ever added (e.g. SQLite checkpoint, HTTP server.close()), it
      // must be moved before or merged into this promise chain — otherwise it
      // will be silently truncated here.
      // NOTE: kill_timeout in ecosystem.config.cjs is 10 s; graceMs defaults to
      // 5 s, leaving 5 s of headroom before pm2 force-kills us. Keep kill_timeout
      // at least 2× graceMs when tuning either value.
      process.exit(0);
    });
  };
  process.on('SIGTERM', () => handler('SIGTERM'));
  process.on('SIGINT', () => handler('SIGINT'));
  // pm2 reload and some terminal-disconnect scenarios deliver SIGHUP; handle it
  // so those paths also drain children rather than leaving orphans.
  process.on('SIGHUP', () => handler('SIGHUP'));
}

/** Test-only: reset internal state between tests. */
export function _resetProcessGroupsForTesting(): void {
  tracked.clear();
  handlersInstalled = false;
  shuttingDown = false;
}

/** Test-only: snapshot of tracked child count. */
export function _trackedChildCountForTesting(): number {
  return tracked.size;
}
