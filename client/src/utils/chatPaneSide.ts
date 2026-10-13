import { useSyncExternalStore } from 'react';

export type ChatPaneSide = 'hub' | 'google';

export const CHAT_PANE_SIDE_KEY = 'agentHub.chatPaneSide';

function readStored(): ChatPaneSide {
  try {
    return globalThis.localStorage?.getItem(CHAT_PANE_SIDE_KEY) === 'google' ? 'google' : 'hub';
  } catch {
    return 'hub';
  }
}

let side: ChatPaneSide | null = null;
const listeners = new Set<() => void>();

/**
 * The side of the Chat pane the user last chose. It lives at module scope so
 * App can tell whether an Agent Hub channel is on screen (for badges and
 * notifications) while ChatPane owns the toggle.
 */
export function getChatPaneSide(): ChatPaneSide {
  if (side === null) side = readStored();
  return side;
}

export function setChatPaneSide(next: ChatPaneSide): void {
  if (getChatPaneSide() === next) return;
  side = next;
  try {
    globalThis.localStorage?.setItem(CHAT_PANE_SIDE_KEY, next);
  } catch {
    // Storage unavailable (private mode): the choice holds for this page view.
  }
  for (const l of listeners) l();
}

/** Forgets the cached choice so the next read comes from storage. For tests. */
export function resetChatPaneSideForTests(): void {
  side = null;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useChatPaneSide(): ChatPaneSide {
  return useSyncExternalStore(subscribe, getChatPaneSide, getChatPaneSide);
}

/** The side actually shown: Google Chat only when the user can read it. */
export function effectiveChatPaneSide(
  chosen: ChatPaneSide,
  googleAvailable: boolean,
): ChatPaneSide {
  return chosen === 'google' && googleAvailable ? 'google' : 'hub';
}
