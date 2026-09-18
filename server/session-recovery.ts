/** Recovery suspends dispatch independently of the worktree's current owner. */
const recovering = new Set<string>();
const resuming = new Set<string>();

export function beginSessionRecovery(sessionId: string): void {
  recovering.add(sessionId);
  resuming.delete(sessionId);
}

export function allowSessionRecoveryTurn(sessionId: string): void {
  resuming.add(sessionId);
}

export function endSessionRecovery(sessionId: string): void {
  recovering.delete(sessionId);
  resuming.delete(sessionId);
}

export function isSessionRecovering(sessionId: string): boolean {
  return recovering.has(sessionId);
}

export function isSessionRecoveryBlockingChat(sessionId: string): boolean {
  return recovering.has(sessionId) && !resuming.has(sessionId);
}
