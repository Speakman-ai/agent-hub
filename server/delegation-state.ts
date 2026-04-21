/**
 * Tracks sessions that are in the delegate/sub-agent phase (CLI finished but
 * work still in flight). Used for active-session UI and active-tasks snapshots.
 */
export const activeDelegationSessions = new Set<string>();

/** Set when `delegation_start` is broadcast; cleared when delegation ends. */
export const delegationSessionUiMeta = new Map<
  string,
  { parentMessageId: string; startedAt: string }
>();

export function clearDelegationUiMeta(sessionId: string): void {
  delegationSessionUiMeta.delete(sessionId);
}
