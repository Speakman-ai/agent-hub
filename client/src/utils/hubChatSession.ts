import { useSyncExternalStore } from 'react';

/**
 * What the user has in progress in Agent Hub chat: the open channel, unsent
 * drafts, in-flight sends and an open edit. It lives at module scope, not in
 * the page, because the page unmounts whenever the Chat pane switches to
 * Google Chat or the Hub pane changes, and a request that resolves after
 * that must still land on the right draft.
 */
export interface HubChatEditState {
  id: string;
  channelId: string;
  text: string;
  saving: boolean;
  error: string | null;
  /**
   * Identity of the save in flight. A save's completion applies only to the
   * attempt that started it, so cancelling and reopening the same message's
   * editor is never cleared or flagged by the earlier save.
   */
  attempt: number;
}

export interface HubChatSessionState {
  selectedId: string | null;
  drafts: Readonly<Record<string, string>>;
  pendingSends: ReadonlySet<string>;
  sendErrors: Readonly<Record<string, string>>;
  editing: HubChatEditState | null;
}

const INITIAL: HubChatSessionState = {
  selectedId: null,
  drafts: {},
  pendingSends: new Set(),
  sendErrors: {},
  editing: null,
};

let state: HubChatSessionState = INITIAL;
const listeners = new Set<() => void>();

let attempts = 0;

/** A fresh identity for one async attempt (an edit save). */
export function nextAttempt(): number {
  attempts += 1;
  return attempts;
}

export function getHubChatSession(): HubChatSessionState {
  return state;
}

export function updateHubChatSession(fn: (s: HubChatSessionState) => HubChatSessionState): void {
  const next = fn(state);
  if (next === state) return;
  state = next;
  for (const l of listeners) l();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useHubChatSession(): HubChatSessionState {
  return useSyncExternalStore(subscribe, getHubChatSession, getHubChatSession);
}

/** Clears a channel's draft only if it still holds the text that was sent. */
export function clearSentDraft(channelId: string, sent: string): void {
  updateHubChatSession((s) =>
    s.drafts[channelId] === sent ? { ...s, drafts: { ...s.drafts, [channelId]: '' } } : s,
  );
}

export function setPendingSend(channelId: string, pending: boolean): void {
  updateHubChatSession((s) => {
    if (s.pendingSends.has(channelId) === pending) return s;
    const pendingSends = new Set(s.pendingSends);
    if (pending) pendingSends.add(channelId);
    else pendingSends.delete(channelId);
    return { ...s, pendingSends };
  });
}

export function resetHubChatSessionForTests(): void {
  state = INITIAL;
  for (const l of listeners) l();
}
