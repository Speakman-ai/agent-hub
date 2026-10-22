import { compareRfc3339 } from '@shared/utils/rfc3339';
import type { ChatSpace } from '@shared/utils/googleChat';

/**
 * Unread dots for the conversation list when push isn't delivering counts.
 *
 * A space is unread when its `lastActiveTime` is newer than where the user
 * has read up to. That position is the later of two sources:
 *   - Google's read state for the space (needs `chat.users.readstate`), and
 *   - the last activity this browser showed the user while the space was open
 *     (localStorage, per Hub user).
 * Without the Google source, a space nobody opened here falls back to the
 * time this browser first started tracking, so turning the feature on never
 * marks the whole history unread.
 *
 * Google's space read state covers top-level messages only, so a thread
 * reply can show a dot until the space is opened here.
 */

/** Per-space Google read position, keyed by space id. */
export type GoogleReadCache = Record<
  string,
  {
    lastReadTime: string | null;
    /** The space's lastActiveTime when this was read. */
    checkedActive: string | null;
    checkedAt: number;
  }
>;

export interface SeenStore {
  /** When this browser started tracking; the fallback read position. */
  since: string;
  /** Space id -> newest activity shown while the space was open. */
  spaces: Record<string, string>;
}

const SEEN_KEY_PREFIX = 'agenthub.googleChat.seen';
const GOOGLE_READ_KEY_PREFIX = 'agenthub.googleChat.googleRead';
/** Only spaces active this recently get a Google read-state check. */
export const READ_STATE_WINDOW_MS = 14 * 24 * 60 * 60_000;
/** Checks issued per list refresh; the rest wait for the next one. */
export const READ_STATE_CHECKS_PER_PASS = 15;
/** Unread spaces are re-checked this often, to catch reads made in Google Chat. */
export const READ_STATE_RECHECK_MS = 2 * 60_000;

/** The later of two RFC 3339 times; null only when both are. */
export function laterOf(a: string | null | undefined, b: string | null | undefined): string | null {
  if (!a) return b ?? null;
  if (!b) return a;
  return compareRfc3339(a, b) >= 0 ? a : b;
}

export function seenStorageKey(userId: string | null): string {
  return `${SEEN_KEY_PREFIX}:${userId || 'local'}`;
}

export function loadSeen(userId: string | null, now: number = Date.now()): SeenStore {
  const fresh: SeenStore = { since: new Date(now).toISOString(), spaces: {} };
  try {
    const raw = localStorage.getItem(seenStorageKey(userId));
    if (!raw) return fresh;
    const parsed = JSON.parse(raw);
    if (typeof parsed?.since !== 'string' || typeof parsed?.spaces !== 'object' || !parsed.spaces) {
      return fresh;
    }
    const spaces: Record<string, string> = {};
    for (const [id, t] of Object.entries(parsed.spaces)) {
      if (typeof t === 'string') spaces[id] = t;
    }
    return { since: parsed.since, spaces };
  } catch {
    return fresh;
  }
}

export function saveSeen(userId: string | null, store: SeenStore): void {
  try {
    localStorage.setItem(seenStorageKey(userId), JSON.stringify(store));
  } catch {
    /* storage full or blocked: dots fall back to this session only */
  }
}

export function googleReadStorageKey(userId: string | null): string {
  return `${GOOGLE_READ_KEY_PREFIX}:${userId || 'local'}`;
}

/**
 * Google read positions from earlier visits. Kept so reopening the page starts
 * from what Google last said instead of an empty cache, which would let stale
 * local positions show dots until every space is re-checked.
 */
export function loadGoogleRead(userId: string | null): GoogleReadCache {
  try {
    const parsed = JSON.parse(localStorage.getItem(googleReadStorageKey(userId)) ?? 'null');
    if (!parsed || typeof parsed !== 'object') return {};
    const out: GoogleReadCache = {};
    for (const [id, e] of Object.entries(parsed as Record<string, any>)) {
      if (
        e &&
        (e.lastReadTime === null || typeof e.lastReadTime === 'string') &&
        (e.checkedActive === null || typeof e.checkedActive === 'string') &&
        Number.isFinite(e.checkedAt)
      ) {
        out[id] = {
          lastReadTime: e.lastReadTime,
          checkedActive: e.checkedActive,
          checkedAt: e.checkedAt,
        };
      }
    }
    return out;
  } catch {
    return {};
  }
}

export function saveGoogleRead(userId: string | null, cache: GoogleReadCache): void {
  try {
    localStorage.setItem(googleReadStorageKey(userId), JSON.stringify(cache));
  } catch {
    /* storage full or blocked: positions are re-read next visit */
  }
}

/** Drop cached positions for spaces no longer listed. */
export function pruneGoogleRead(
  cache: GoogleReadCache,
  spaceIds: Iterable<string>,
): GoogleReadCache {
  const keep = new Set(spaceIds);
  const ids = Object.keys(cache);
  if (ids.every((id) => keep.has(id))) return cache;
  const out: GoogleReadCache = {};
  for (const id of ids) if (keep.has(id)) out[id] = cache[id];
  return out;
}

/**
 * A space with no Google position yet that the read-state pass will check.
 * Its dot waits for that answer: this browser's position can be stale when
 * the user read the space in Google Chat or on another device.
 */
function awaitingGoogleRead(
  space: Pick<ChatSpace, 'id' | 'lastActiveTime'>,
  google: GoogleReadCache,
  now: number,
): boolean {
  if (!space.id || google[space.id] || !space.lastActiveTime) return false;
  const active = Date.parse(space.lastActiveTime);
  return Number.isFinite(active) && active >= now - READ_STATE_WINDOW_MS;
}

/** Record that the user saw `space` up to `time`. Returns the same store when nothing moved. */
export function markSeen(store: SeenStore, spaceId: string, time: string | null): SeenStore {
  if (!time) return store;
  const prev = store.spaces[spaceId];
  if (prev && compareRfc3339(time, prev) <= 0) return store;
  return { ...store, spaces: { ...store.spaces, [spaceId]: time } };
}

/** Drop entries for spaces no longer listed, so the stored map can't grow forever. */
export function pruneSeen(store: SeenStore, spaceIds: Iterable<string>): SeenStore {
  const keep = new Set(spaceIds);
  const ids = Object.keys(store.spaces);
  if (ids.every((id) => keep.has(id))) return store;
  const spaces: Record<string, string> = {};
  for (const id of ids) if (keep.has(id)) spaces[id] = store.spaces[id];
  return { ...store, spaces };
}

/**
 * Whether the space shows an unread dot. With read-state access, a space whose
 * Google position hasn't been fetched yet shows nothing rather than guessing.
 * Only spaces too idle to be checked fall back to this browser's position.
 */
export function isSpaceUnread(
  space: Pick<ChatSpace, 'id' | 'lastActiveTime'>,
  opts: { google: GoogleReadCache; seen: SeenStore; useGoogle: boolean; now?: number },
): boolean {
  if (!space.id || !space.lastActiveTime) return false;
  const local = opts.seen.spaces[space.id] ?? null;
  let readThrough: string | null;
  if (opts.useGoogle) {
    const entry = opts.google[space.id];
    if (!entry) {
      if (!local || awaitingGoogleRead(space, opts.google, opts.now ?? Date.now())) return false;
      readThrough = local;
    } else {
      readThrough = laterOf(entry.lastReadTime, local);
    }
  } else {
    readThrough = laterOf(local, opts.seen.since);
  }
  return !readThrough || compareRfc3339(space.lastActiveTime, readThrough) > 0;
}

/**
 * Spaces whose Google read state should be fetched now, up to the per-pass
 * limit. Spaces never checked, or active since their last check, come first,
 * most recently active first. Still-unread spaces due for a re-check fill
 * what is left, longest-unchecked first, so re-checks rotate and can never
 * crowd out a space that has no position yet. Spaces idle for longer than the
 * window are skipped.
 *
 * Accepted trade-off: if more than the limit of spaces gain new activity on
 * every refresh, the least recently active of them wait, since fresh spaces
 * go newest first. That is the right priority for a busy list, and it clears
 * once activity settles.
 */
export function spacesNeedingReadState(
  spaces: Pick<ChatSpace, 'id' | 'lastActiveTime'>[],
  google: GoogleReadCache,
  opts: { now: number; skip?: Set<string>; limit?: number },
): string[] {
  const cutoff = opts.now - READ_STATE_WINDOW_MS;
  const fresh: string[] = [];
  const rechecks: { id: string; checkedAt: number }[] = [];
  const sorted = [...spaces].sort((a, b) => compareRfc3339(b.lastActiveTime, a.lastActiveTime));
  for (const space of sorted) {
    if (!space.id || !space.lastActiveTime || opts.skip?.has(space.id)) continue;
    const active = Date.parse(space.lastActiveTime);
    if (!Number.isFinite(active) || active < cutoff) continue;
    const entry = google[space.id];
    if (!entry || entry.checkedActive !== space.lastActiveTime) {
      fresh.push(space.id);
      continue;
    }
    const unread =
      !entry.lastReadTime || compareRfc3339(space.lastActiveTime, entry.lastReadTime) > 0;
    if (unread && opts.now - entry.checkedAt >= READ_STATE_RECHECK_MS) {
      rechecks.push({ id: space.id, checkedAt: entry.checkedAt });
    }
  }
  // Stable sort keeps recency order among spaces checked at the same time.
  rechecks.sort((a, b) => a.checkedAt - b.checkedAt);
  return [...fresh, ...rechecks.map((r) => r.id)].slice(
    0,
    opts.limit ?? READ_STATE_CHECKS_PER_PASS,
  );
}

/**
 * The list's dot state for every space, for the Chat badges. `unknown` holds
 * spaces whose Google read position hasn't been fetched and is either pending
 * or was never shown by this browser, so a publisher keeps whatever it last knew for them instead of
 * clearing them on mount. The open space is being read and is never unread.
 */
export function partitionUnreadSpaces(
  spaces: Pick<ChatSpace, 'id' | 'lastActiveTime'>[],
  opts: {
    google: GoogleReadCache;
    seen: SeenStore;
    useGoogle: boolean;
    selectedId: string | null;
    now?: number;
  },
): { unread: string[]; unknown: string[] } {
  const now = opts.now ?? Date.now();
  const unread: string[] = [];
  const unknown: string[] = [];
  for (const space of spaces) {
    if (!space.id || space.id === opts.selectedId) continue;
    if (
      opts.useGoogle &&
      !opts.google[space.id] &&
      (!opts.seen.spaces[space.id] || awaitingGoogleRead(space, opts.google, now))
    ) {
      unknown.push(space.id);
    } else if (isSpaceUnread(space, { ...opts, now })) {
      unread.push(space.id);
    }
  }
  return { unread, unknown };
}
