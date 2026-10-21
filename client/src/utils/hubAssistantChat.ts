import { useSyncExternalStore } from 'react';

/** The testid on the assistant transcript's scroll container. */
export const HUB_ASSISTANT_SCROLL_TESTID = 'hub-assistant-scroll';

// Server Agent replies that finished while the transcript was off screen.
// Kept at module scope so every badge reads one count.
let unread = 0;
const listeners = new Set<() => void>();

function emit(): void {
  for (const l of listeners) l();
}

export function getHubAssistantUnread(): number {
  return unread;
}

export function markHubAssistantReplyUnseen(): void {
  unread += 1;
  emit();
}

export function clearHubAssistantUnread(): void {
  if (unread === 0) return;
  unread = 0;
  emit();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useHubAssistantUnread(): number {
  return useSyncExternalStore(subscribe, getHubAssistantUnread, getHubAssistantUnread);
}

/**
 * Whether the assistant transcript is on screen: mounted and the tab is
 * visible. A reply that lands while this is false counts as unseen.
 */
export function isHubAssistantTranscriptVisible(doc: Document = document): boolean {
  if (doc.visibilityState === 'hidden') return false;
  const el = doc.querySelector(`[data-testid="${HUB_ASSISTANT_SCROLL_TESTID}"]`);
  return !!el && el.getClientRects().length > 0;
}

/**
 * Records a finished Hub assistant turn: it counts toward the badge unless
 * the user is looking at the transcript right now.
 */
export function noteHubAssistantTurnDone(visible: boolean): void {
  if (!visible) markHubAssistantReplyUnseen();
}

export function resetHubAssistantUnreadForTests(): void {
  unread = 0;
  emit();
}

/**
 * The Server Agent page renders the shared active-session transcript, so it must
 * only do so while that session is the user's Hub session. Any other active
 * session (a project session restored or refreshed in behind the Hub) would
 * otherwise show its messages on the Server Agent page.
 */
export function isHubAssistantSessionActive(
  activeSessionId: string | null | undefined,
  hubSessionId: string | null | undefined,
): boolean {
  return !!hubSessionId && activeSessionId === hubSessionId;
}

/**
 * Session id to re-select when the Server Agent page is on screen but a different
 * session became active, or null when nothing needs to change.
 */
export function hubAssistantSessionToRestore(opts: {
  inChat: boolean;
  activeSessionId: string | null | undefined;
  hubSessionId: string | null | undefined;
}): string | null {
  if (!opts.inChat || !opts.hubSessionId) return null;
  return opts.activeSessionId === opts.hubSessionId ? null : opts.hubSessionId;
}

/**
 * When a session-list refresh no longer contains the active session, the
 * caller falls back to the newest row. The Hub session never appears in a
 * project agent's list, so it must be kept rather than replaced.
 */
export function shouldReplaceMissingActiveSession(
  activeSessionId: string | null | undefined,
  listedIds: readonly string[],
  hubSessionId: string | null | undefined,
): boolean {
  if (!activeSessionId) return false;
  if (hubSessionId && activeSessionId === hubSessionId) return false;
  return !listedIds.includes(activeSessionId);
}
