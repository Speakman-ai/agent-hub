export type SessionWorktreeLockOwner =
  | 'branch-switch'
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
