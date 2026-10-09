import { compareRfc3339 } from '@shared/utils/rfc3339';
import type { ChatSpace } from './googleChat';

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
 */
export function isSpaceUnread(
  space: Pick<ChatSpace, 'id' | 'lastActiveTime'>,
  opts: { google: GoogleReadCache; seen: SeenStore; useGoogle: boolean },
): boolean {
  if (!space.id || !space.lastActiveTime) return false;
  const local = opts.seen.spaces[space.id] ?? null;
  let readThrough: string | null;
  if (opts.useGoogle) {
    const entry = opts.google[space.id];
    if (!entry) {
      if (!local) return false;
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
