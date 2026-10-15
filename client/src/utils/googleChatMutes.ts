/**
 * Google Chat spaces the signed-in user muted. The server owns the list
 * (per Hub user); this store mirrors it so the Chat pane, the notifier, and the
 * unread badges all agree. Muted spaces raise no notices and add nothing to
 * badges, but still show in the list.
 */
import { useEffect, useSyncExternalStore } from 'react';
import { api } from './api';
import { WS_RECONNECTED_EVENT } from './googleChatDrafts';

export const MUTES_EVENT = 'google_chat_mutes';

export interface ChatMuteState {
  /** True once a server list has been applied. Notices and badges wait for it. */
  loaded: boolean;
  /** The server list with this tab's pending writes laid over it. */
  spaceIds: ReadonlySet<string>;
}

/** A muted list as the server sends it (GET, PUT response, and push). */
export interface MuteSnapshot {
  spaceIds?: string[];
  revision?: number;
}

export interface MuteResult extends MuteSnapshot {
  googleSync?: 'synced' | 'not_granted' | 'failed';
  googleError?: string;
}

export interface ChatMuteApi {
  getGoogleChatMutes: () => Promise<MuteSnapshot | null | undefined>;
  setGoogleChatSpaceMuted: (spaceId: string, muted: boolean) => Promise<MuteResult>;
}

export interface ChatMuteStore {
  getState: () => ChatMuteState;
  subscribe: (listener: () => void) => () => void;
  /** Fetch the server list. Resolves true once the store holds a loaded list. */
  load: () => Promise<boolean>;
  setMuted: (spaceId: string, muted: boolean) => Promise<MuteResult>;
  /** Apply a `google_chat_mutes` push with the full list. */
  applyEvent: (detail: unknown) => void;
  reset: () => void;
}

const EMPTY: ChatMuteState = { loaded: false, spaceIds: new Set() };

/**
 * Every list the server sends carries a revision that increases with each
 * change, so the store keeps whichever list is newest by revision. Arrival
 * order never matters: a GET that read the list before a write committed can
 * answer after that write and is still dropped, and the same rule covers
 * overlapping loads, writes from other tabs, and pushes.
 *
 * A write in flight shows its intended value for its own space only, over the
 * newest server list, until it settles. Failure drops the overlay, which puts
 * the server's value back.
 */
export function createChatMuteStore(muteApi: ChatMuteApi = api): ChatMuteStore {
  let server: { spaceIds: Set<string>; revision: number } | null = null;
  const pending = new Map<string, { muted: boolean; token: number }>();
  let writeSeq = 0;
  // Bumped by reset (sign-out, account switch). Answers to requests issued
  // under an older epoch belong to another session and are dropped.
  let epoch = 0;
  let state = EMPTY;
  const listeners = new Set<() => void>();

  const recompute = () => {
    const ids = new Set(server?.spaceIds ?? []);
    for (const [id, p] of pending) {
      if (p.muted) ids.add(id);
      else ids.delete(id);
    }
    state = { loaded: server !== null, spaceIds: ids };
    for (const l of listeners) l();
  };

  const applySnapshot = (body: unknown, issuedEpoch: number): void => {
    if (issuedEpoch !== epoch) return;
    const snap = body as MuteSnapshot | null | undefined;
    if (!Array.isArray(snap?.spaceIds) || typeof snap?.revision !== 'number') return;
    if (server && snap.revision <= server.revision) return;
    server = {
      spaceIds: new Set(snap.spaceIds.filter((id): id is string => typeof id === 'string')),
      revision: snap.revision,
    };
    recompute();
  };

  return {
    getState: () => state,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    load: async () => {
      const issued = epoch;
      try {
        applySnapshot(await muteApi.getGoogleChatMutes(), issued);
      } catch {
        /* not signed in or offline: keep what we have */
      }
      return state.loaded;
    },
    setMuted: async (spaceId, muted) => {
      const issued = epoch;
      const token = ++writeSeq;
      pending.set(spaceId, { muted, token });
      recompute();
      const settle = () => {
        if (issued === epoch && pending.get(spaceId)?.token === token) {
          pending.delete(spaceId);
          recompute();
        }
      };
      try {
        const body = await muteApi.setGoogleChatSpaceMuted(spaceId, muted);
        applySnapshot(body, issued);
        settle();
        return body;
      } catch (err) {
        settle();
        throw err;
      }
    },
    applyEvent: (detail) => applySnapshot(detail, epoch),
    reset: () => {
      epoch++;
      server = null;
      pending.clear();
      recompute();
    },
  };
}

let singleton: ChatMuteStore | null = null;
export function chatMuteStore(): ChatMuteStore {
  singleton ??= createChatMuteStore();
  return singleton;
}

export function useChatMutes(store: ChatMuteStore = chatMuteStore()): ChatMuteState {
  return useSyncExternalStore(store.subscribe, store.getState, store.getState);
}

/** Delay before the Nth retry of a failed initial load (1-based), capped at a minute. */
export function muteLoadRetryMs(attempt: number): number {
  return Math.min(60_000, 2_000 * 2 ** (attempt - 1));
}

/**
 * Keep the mute list in sync for the signed-in user: load on sign-in and on
 * WebSocket reconnect, and apply pushes from other tabs and devices. A failed
 * initial load is retried with backoff, since notifications wait for it.
 */
export function useChatMutesSync(
  enabled: boolean,
  userId: string | null,
  store: ChatMuteStore = chatMuteStore(),
): void {
  useEffect(() => {
    store.reset();
    if (!enabled) return undefined;
    let cancelled = false;
    let retry: ReturnType<typeof setTimeout> | null = null;
    let attempt = 0;
    const loadUntilReady = async () => {
      if (cancelled) return;
      if (await store.load()) return;
      if (cancelled) return;
      attempt += 1;
      retry = setTimeout(() => void loadUntilReady(), muteLoadRetryMs(attempt));
    };
    void loadUntilReady();
    const onEvent = (e: Event) => store.applyEvent((e as CustomEvent).detail);
    const onReconnect = () => void store.load();
    window.addEventListener(MUTES_EVENT, onEvent);
    window.addEventListener(WS_RECONNECTED_EVENT, onReconnect);
    return () => {
      cancelled = true;
      if (retry) clearTimeout(retry);
      window.removeEventListener(MUTES_EVENT, onEvent);
      window.removeEventListener(WS_RECONNECTED_EVENT, onReconnect);
    };
  }, [enabled, userId, store]);
}

/**
 * Notification gate for the signed-in user's Chat. Notices stay off until the
 * saved mute list has loaded, so a muted space can't notify during the load.
 */
/**
 * Whether a space must stay quiet: no notice, no badge count, no unread pill
 * or dot. True for muted spaces, and for every space until the mute list has
 * loaded, since any of them may turn out to be muted. Every attention surface
 * goes through this, so they can't disagree.
 */
export function isSpaceQuiet(mutes: ChatMuteState, spaceId: string): boolean {
  return !mutes.loaded || mutes.spaceIds.has(spaceId);
}

export function chatNotifyGate(
  chatEnabled: boolean,
  mutes: ChatMuteState,
): { enabled: boolean; isMutedSpace: (spaceId: string) => boolean } {
  return {
    enabled: chatEnabled && mutes.loaded,
    isMutedSpace: (spaceId) => isSpaceQuiet(mutes, spaceId),
  };
}

/** Count one notice toward the fallback badge, under its space. */
export function addAnnouncement(
  bySpace: Record<string, number>,
  notice: { spaceId: string; count: number },
): Record<string, number> {
  return { ...bySpace, [notice.spaceId]: (bySpace[notice.spaceId] ?? 0) + notice.count };
}

/**
 * Unread count for Chat badges. With push active the push store tracks real
 * unread counts per space (keyed `spaces/{id}`); without it, fall back to the
 * messages the notifier announced per space since the user last opened the
 * Chat pane, plus one for each other space that shows an unread dot in the
 * Google Chat list. Never sum push with either: the notifier also announces
 * pushed messages.
 *
 * Both sources are filtered by the current mute list at read time, so muting
 * a space (here or in another tab) removes what it already contributed. Until
 * the mute list loads the badge stays at zero, matching the notifier, which
 * also waits for it.
 */
export function chatBadgeCount(
  pushActive: boolean,
  pushUnread: Record<string, { count: number }>,
  announcedBySpace: Record<string, number>,
  mutes: ChatMuteState,
  unreadSpaces: Iterable<string> = [],
): number {
  let total = 0;
  if (pushActive) {
    for (const [name, s] of Object.entries(pushUnread)) {
      if (!isSpaceQuiet(mutes, name.replace(/^spaces\//, ''))) total += s.count;
    }
    return total;
  }
  for (const [spaceId, n] of Object.entries(announcedBySpace)) {
    if (!isSpaceQuiet(mutes, spaceId)) total += n;
  }
  for (const spaceId of unreadSpaces) {
    if (!announcedBySpace[spaceId] && !isSpaceQuiet(mutes, spaceId)) total += 1;
  }
  return total;
}
