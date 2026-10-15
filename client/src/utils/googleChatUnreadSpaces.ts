import { useSyncExternalStore } from 'react';

/**
 * The Google Chat spaces that show an unread dot, shared outside the Chat page
 * so the Chat badges can count them when push isn't delivering counts.
 *
 * The Google Chat list is the source of truth: it publishes its dot set each
 * time it changes. Between visits, an announced message marks its space
 * unread here. The set is kept in localStorage per Hub user, so the badge is
 * right after a reload, before the list has mounted.
 */

const KEY_PREFIX = 'agenthub.googleChat.unreadSpaces';

export function unreadSpacesKey(userId: string | null): string {
  return `${KEY_PREFIX}:${userId || 'local'}`;
}

const EMPTY: ReadonlySet<string> = new Set();

export interface UnreadSpacesStore {
  get(userId: string | null): ReadonlySet<string>;
  /** Replace a user's set. `keep` ids keep their current membership. */
  publish(userId: string | null, unread: Iterable<string>, keep?: Iterable<string>): void;
  markUnread(userId: string | null, spaceId: string): void;
  subscribe(listener: () => void): () => void;
}

function sameSet(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) return false;
  for (const id of a) if (!b.has(id)) return false;
  return true;
}

export function createUnreadSpacesStore(
  storage: Storage | null = safeStorage(),
  events: EventTarget | null = typeof window === 'undefined' ? null : window,
): UnreadSpacesStore {
  const cache = new Map<string, ReadonlySet<string>>();
  const listeners = new Set<() => void>();

  // Another tab publishing or reading a space must update this tab's badge,
  // so drop the cached set and let the next get re-read storage.
  events?.addEventListener('storage', (event) => {
    const key = (event as StorageEvent).key;
    if (key === null) cache.clear();
    else if (key.startsWith(`${KEY_PREFIX}:`) && cache.has(key)) cache.delete(key);
    else return;
    for (const l of listeners) l();
  });

  const read = (userId: string | null): ReadonlySet<string> => {
    const key = unreadSpacesKey(userId);
    const hit = cache.get(key);
    if (hit) return hit;
    let set: ReadonlySet<string> = EMPTY;
    try {
      const parsed = JSON.parse(storage?.getItem(key) ?? 'null');
      if (Array.isArray(parsed)) {
        set = new Set(parsed.filter((id): id is string => typeof id === 'string' && !!id));
      }
    } catch {
      /* corrupt entry: start empty */
    }
    cache.set(key, set);
    return set;
  };

  const write = (userId: string | null, next: ReadonlySet<string>) => {
    if (sameSet(read(userId), next)) return;
    const key = unreadSpacesKey(userId);
    cache.set(key, next);
    try {
      storage?.setItem(key, JSON.stringify([...next]));
    } catch {
      /* storage full or blocked: the count lasts for this page only */
    }
    for (const l of listeners) l();
  };

  return {
    get: read,
    publish(userId, unread, keep) {
      const prev = read(userId);
      const next = new Set(unread);
      for (const id of keep ?? []) if (prev.has(id)) next.add(id);
      write(userId, next);
    },
    markUnread(userId, spaceId) {
      if (!spaceId) return;
      const prev = read(userId);
      if (prev.has(spaceId)) return;
      write(userId, new Set([...prev, spaceId]));
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

function safeStorage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

let shared: UnreadSpacesStore | null = null;
export function unreadSpacesStore(): UnreadSpacesStore {
  shared ??= createUnreadSpacesStore();
  return shared;
}

export function useGoogleChatUnreadSpaces(
  userId: string | null,
  store: UnreadSpacesStore = unreadSpacesStore(),
): ReadonlySet<string> {
  const get = () => store.get(userId);
  return useSyncExternalStore(store.subscribe, get, get);
}
