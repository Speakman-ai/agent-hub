/**
 * Agent-written Google Chat replies held for the owner's approval. The server
 * owns the state; these helpers fold live updates into a local list and decide
 * where each draft shows in the Chat pane.
 */
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { api } from './api';
import type { ChatMessage } from './googleChat';
import type { ChatDraft, DraftFilter } from '@shared/utils/googleChatDrafts';
import { DraftListController, EMPTY_DRAFT_SNAPSHOT } from '@shared/utils/googleChatDraftList';

export {
  applyDraftUpdate,
  reconcileDraftSnapshot,
  isOpenDraft,
  type ChatDraft,
  type ChatDraftStatus,
  type DraftFilter,
} from '@shared/utils/googleChatDrafts';

export const DRAFT_EVENT = 'google_chat_draft_update';
/** Fanned out by App when the WebSocket reconnects (useWsReconnectBroadcast). */
export const WS_RECONNECTED_EVENT = 'agenthub:ws_reconnected';

export { SENDING_RECHECK_MS } from '@shared/utils/googleChatDraftList';

/**
 * Place each draft under the newest loaded message of its thread. Drafts with
 * no thread, or whose thread isn't loaded, go in `unplaced` (shown at the end).
 */
export function placeDrafts(
  messages: Pick<ChatMessage, 'name' | 'threadName'>[],
  drafts: ChatDraft[],
): { byMessage: Map<string, ChatDraft[]>; unplaced: ChatDraft[] } {
  const lastInThread = new Map<string, string>();
  for (const m of messages) {
    if (m.threadName && m.name) lastInThread.set(m.threadName, m.name);
  }
  const byMessage = new Map<string, ChatDraft[]>();
  const unplaced: ChatDraft[] = [];
  for (const d of drafts) {
    const anchor = d.threadName ? lastInThread.get(d.threadName) : undefined;
    if (!anchor) {
      unplaced.push(d);
      continue;
    }
    byMessage.set(anchor, [...(byMessage.get(anchor) ?? []), d]);
  }
  return { byMessage, unplaced };
}

/**
 * Open drafts for a session or space, kept live from the WebSocket bridge.
 *
 * A fresh `DraftListController` is created for each filter and disposed when
 * it changes, so callbacks captured under an old filter (a card's action
 * result, a failed action's reload, a late load) are no-ops. See
 * `shared/utils/googleChatDraftList.ts` for the sync rules.
 */
export function useChatDrafts(filter: DraftFilter, enabled = true) {
  const { sessionId, spaceId } = filter;
  const active = enabled && !!(sessionId || spaceId);
  const key = active ? `${sessionId ?? ''}\u0000${spaceId ?? ''}` : '';
  const [owned, setOwned] = useState<{ key: string; c: DraftListController } | null>(null);
  // Before the effect for a new filter runs, the previous controller is still
  // in state; it is never read for a filter it wasn't built for.
  const controller = owned && owned.key === key ? owned.c : null;

  useEffect(() => {
    if (!active) {
      setOwned(null);
      return;
    }
    const c = new DraftListController(
      { sessionId, spaceId },
      { fetch: (f) => api.listGoogleChatDrafts(f) },
    );
    setOwned({ key, c });
    c.reload();
    const onUpdate = (event: Event) => c.apply((event as CustomEvent).detail?.draft);
    window.addEventListener(DRAFT_EVENT, onUpdate);
    // Events sent while the socket was down are lost; re-read on reconnect.
    window.addEventListener(WS_RECONNECTED_EVENT, c.reload);
    return () => {
      window.removeEventListener(DRAFT_EVENT, onUpdate);
      window.removeEventListener(WS_RECONNECTED_EVENT, c.reload);
      c.dispose();
    };
    // `key` is the filter identity; sessionId/spaceId are read through it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const subscribe = useCallback(
    (listener: () => void) => controller?.subscribe(listener) ?? (() => {}),
    [controller],
  );
  const getSnapshot = useCallback(
    () => controller?.getSnapshot() ?? EMPTY_DRAFT_SNAPSHOT,
    [controller],
  );
  const snapshot = useSyncExternalStore(subscribe, getSnapshot);
  const noop = useCallback(() => {}, []);

  return {
    drafts: snapshot.drafts,
    error: snapshot.error,
    reload: controller?.reload ?? noop,
    /** Apply an action result locally too, in case the socket is down. */
    applyLocal: controller?.apply ?? noop,
  };
}
