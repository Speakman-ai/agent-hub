export type SessionWorktreeLockOwner =
  | 'branch-switch'
  | 'workspace-setup'
  | 'turn-start'
  | 'multi-agent-round'
  | 'finalize';

const owners = new Map<string, SessionWorktreeLockOwner>();
const waiters = new Map<string, Array<() => void>>();

export function tryAcquireSessionWorktreeLock(
  sessionId: string,
  owner: SessionWorktreeLockOwner,
): boolean {
  if (owners.has(sessionId)) return false;
  owners.set(sessionId, owner);
  return true;
}

export function getSessionWorktreeLockOwner(sessionId: string): SessionWorktreeLockOwner | null {
  return owners.get(sessionId) ?? null;
}

export function waitForSessionWorktreeLockRelease(sessionId: string): Promise<void> {
  if (!owners.has(sessionId)) return Promise.resolve();
  return new Promise((resolve) => {
    const sessionWaiters = waiters.get(sessionId) ?? [];
    sessionWaiters.push(resolve);
    waiters.set(sessionId, sessionWaiters);
  });
}

export function getSessionWorktreeLockWaiterCount(sessionId: string): number {
  return waiters.get(sessionId)?.length ?? 0;
}

/**
 * Acquire the per-session worktree lock, waiting for any current owner first.
 *
 * The failed try + waiter registration is atomic in Node's synchronous turn:
 * no release can interleave between the two calls. Multiple released waiters
 * race through the loop, and only the one that acquires continues; the rest
 * register for the next release instead of entering their critical sections.
 */
export async function acquireSessionWorktreeLock(
  sessionId: string,
  owner: SessionWorktreeLockOwner,
): Promise<void> {
  while (!tryAcquireSessionWorktreeLock(sessionId, owner)) {
    await waitForSessionWorktreeLockRelease(sessionId);
  }
}

export function releaseSessionWorktreeLock(
  sessionId: string,
  owner: SessionWorktreeLockOwner,
): void {
  if (owners.get(sessionId) !== owner) return;
  owners.delete(sessionId);
  const sessionWaiters = waiters.get(sessionId);
  if (!sessionWaiters) return;
  waiters.delete(sessionId);
  for (const resolve of sessionWaiters) resolve();
}

export function isSessionWorktreeLocked(sessionId: string): boolean {
  return owners.has(sessionId);
}
