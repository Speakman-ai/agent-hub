import { useSyncExternalStore } from 'react';
import { getHubChatSession, subscribeHubChatSession, updateHubChatSession } from './hubChatSession';

/**
 * Rail id of the pinned Agent Hub DM. It is not a hub_chat channel: selecting
 * it shows the user's Hub assistant session, the same one the assistant
 * column renders.
 */
export const HUB_ASSISTANT_CHANNEL_ID = '__hub_assistant__';

/** The testid on the assistant transcript's scroll container. */
export const HUB_ASSISTANT_SCROLL_TESTID = 'hub-assistant-scroll';

const isAssistantSelected = () => getHubChatSession().selectedId === HUB_ASSISTANT_CHANNEL_ID;

/** True while the pinned Agent Hub DM is the selected Chat conversation. */
export function useHubAssistantSelected(): boolean {
  return useSyncExternalStore(subscribeHubChatSession, isAssistantSelected, isAssistantSelected);
}

export function selectHubAssistantDm(): void {
  updateHubChatSession((s) =>
    s.selectedId === HUB_ASSISTANT_CHANNEL_ID ? s : { ...s, selectedId: HUB_ASSISTANT_CHANNEL_ID },
  );
  clearHubAssistantUnread();
}

// Assistant replies that finished while the transcript was off screen. Kept
// at module scope so the Chat rail and App's badges read one count.
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
 * Whether the assistant transcript is on screen: mounted, not inside a
 * `display: none` ancestor (collapsed column, other mobile tab), and the tab
 * is visible. A reply that lands while this is false counts as unseen.
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
