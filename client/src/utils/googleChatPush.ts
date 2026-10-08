import { useEffect, useSyncExternalStore } from 'react';
import { compareRfc3339 } from '@shared/utils/rfc3339';
import { api } from './api';
import { chatConsent, type GoogleStatusLike } from './googleSurface';

/**
 * Google Chat push state shared by the Hub's Chat tab badge and the Chat pane:
 * whether pushed events can reach this browser, and unread counts per space.
 *
 * Ordering. Unread and subscription state reach this store over two channels
 * (WebSocket events and HTTP responses) that can arrive in any order. The
 * server stamps every change with the user's next sequence number and every
 * payload carries it (see `google_chat_user_seq` in server/db.ts), so the
 * store applies a payload only when its number is newer than what it holds,
 * per space for unread and per user for the subscription. Arrival order never
 * decides anything.
 *
 * Layers. Server answers and this tab's own guesses (a request found push
 * unavailable; a read is in flight) live in separate layers, and what the UI
 * sees is derived from both. A guess never edits server state, and each
 * guess is dropped once the server settles it, so recovery never depends on
 * the server's version moving.
 *
 * `pushActive` is the one answer to "may the pane relax polling?". It is
 * derived in a single place from every input push delivery depends on: the
 * WebSocket being connected, the server reporting an ACTIVE subscription, and
 * that subscription not having expired by the clock. The store re-derives it
 * whenever any input changes, including a timer at `expireTime`, and every
 * doubt resolves to false, which means poll.
 */

export interface SpaceUnread {
  spaceName: string;
  count: number;
  lastMessageTime: string | null;
  /** Server sequence number of this space's last unread change. */
  version: number;
}

export interface ChatPushSubscription {
  state: 'ACTIVE' | 'SUSPENDED' | 'EXPIRED' | 'ERROR';
  expireTime: string | null;
  suspensionReason: string | null;
  lastError: string | null;
}

export interface ChatPushState {
  /** Server has Chat push set up. False also while unknown. */
  configured: boolean;
  subscription: ChatPushSubscription | null;
  /** The app WebSocket is open, so pushed events can arrive. */
  connected: boolean;
  /** Derived: push replaces fast polling right now. See the module comment. */
  pushActive: boolean;
  unread: Record<string, SpaceUnread>;
}

export const EMPTY_CHAT_PUSH_STATE: ChatPushState = {
  configured: false,
  subscription: null,
  connected: false,
  pushActive: false,
  unread: {},
};

/**
 * Unread counts plus the versions they are known at. `floor` is the version
 * of the last snapshot applied: every space is known at least that well, and
 * `versions` holds spaces updated past it.
 */
export interface UnreadModel {
  unread: Record<string, SpaceUnread>;
  versions: Record<string, number>;
  floor: number;
}

export const EMPTY_UNREAD_MODEL: UnreadModel = { unread: {}, versions: {}, floor: 0 };

function heldVersion(model: UnreadModel, spaceName: string): number {
  return Math.max(model.versions[spaceName] ?? 0, model.floor);
}

/** Apply one space's server state if it is newer than what the model holds. */
export function applyVersionedUnread(model: UnreadModel, update: SpaceUnread): UnreadModel {
  if (!(update.version > heldVersion(model, update.spaceName))) return model;
  const unread = { ...model.unread };
  if (update.count > 0) unread[update.spaceName] = update;
  else delete unread[update.spaceName];
  return {
    unread,
    versions: { ...model.versions, [update.spaceName]: update.version },
    floor: model.floor,
  };
}

/**
 * Apply a full list consistent with `version`. Spaces the model already knows
 * past that version keep their state; everything else takes the snapshot's
 * (absent = no unread). An older snapshot than one already applied is ignored.
 */
export function applyUnreadSnapshot(
  model: UnreadModel,
  snapshot: { spaces: SpaceUnread[]; version: number },
): UnreadModel {
  if (snapshot.version < model.floor) return model;
  const unread: Record<string, SpaceUnread> = {};
  const versions: Record<string, number> = {};
  for (const [space, v] of Object.entries(model.versions)) {
    if (v > snapshot.version) {
      versions[space] = v;
      if (model.unread[space]) unread[space] = model.unread[space];
    }
  }
  for (const s of snapshot.spaces) {
    if (s && s.spaceName && s.count > 0 && !(s.spaceName in versions)) unread[s.spaceName] = s;
  }
  return { unread, versions, floor: snapshot.version };
}

export function totalUnread(unread: Record<string, SpaceUnread>): number {
  return Object.values(unread).reduce((n, s) => n + s.count, 0);
}

export function formatUnreadCount(count: number): string {
  return count > 99 ? '99+' : String(count);
}

/**
 * Whether push replaces polling at `now`: connected, configured, ACTIVE, and
 * not past `expireTime`. A missing or unparseable expiry counts as expired.
 */
export function isPushActive(
  state: Pick<ChatPushState, 'configured' | 'subscription' | 'connected'>,
  now: number = Date.now(),
): boolean {
  const sub = state.subscription;
  if (!state.connected || !state.configured || !sub || sub.state !== 'ACTIVE') return false;
  // Google always reports an expiry; without one we can't know when push
  // stops, so poll.
  if (!sub.expireTime) return false;
  const at = Date.parse(sub.expireTime);
  return Number.isFinite(at) && at > now;
}

/** `spaces/AAA` → `AAA`; the pane keys spaces by id. */
export function spaceIdFromName(spaceName: unknown): string | null {
  if (typeof spaceName !== 'string') return null;
  const m = /^spaces\/([A-Za-z0-9_-]+)$/.exec(spaceName);
  return m ? m[1] : null;
}

function toSpaceUnread(raw: any, spaceName: unknown): SpaceUnread | null {
  const version = Number(raw?.version);
  if (typeof spaceName !== 'string' || !Number.isFinite(version)) return null;
  return {
    spaceName,
    count: Number(raw?.count) || 0,
    lastMessageTime: raw?.lastMessageTime ?? null,
    version,
  };
}

/** Normalize a WS payload into a versioned unread update, or null when it has none. */
export function unreadUpdateFromEvent(event: any): SpaceUnread | null {
  if (!event) return null;
  if (event.type === 'google_chat_message' && event.unread) {
    return toSpaceUnread(event.unread, event.spaceName);
  }
  if (event.type === 'google_chat_unread') return toSpaceUnread(event, event.spaceName);
  return null;
}

type ChatPushApi = Pick<
  typeof api,
  | 'getGoogleStatus'
  | 'ensureGoogleChatSubscription'
  | 'listGoogleChatUnread'
  | 'markGoogleChatSpaceRead'
>;

export interface ChatPushStore {
  getState: () => ChatPushState;
  subscribe: (listener: () => void) => () => void;
  /**
   * Report WebSocket connectivity. Going down turns push off at once; coming
   * back re-reads everything, since events sent meanwhile are not replayed.
   */
  setConnected: (connected: boolean) => void;
  /**
   * Listen for events, then load unread and make sure the user's subscription
   * exists. Repeats until the subscription endpoint gives an answer.
   */
  start: () => Promise<void>;
  /** Re-read unread and subscription state, e.g. after consent changed. */
  sync: () => Promise<void>;
  refreshUnread: () => Promise<void>;
  markRead: (spaceId: string, readThrough: string | null) => Promise<void>;
  /** Apply a raw WS event (google_chat_*). */
  applyEvent: (event: any) => void;
  stop: () => void;
}

/** A failed mark-read is tried this many times per boundary, backing off from the base delay. */
export const MAX_READ_ATTEMPTS = 3;
export const READ_RETRY_BASE_MS = 2_000;

// setTimeout overflows past ~24.8 days; longer expiries re-arm on firing.
const MAX_TIMER_MS = 2 ** 31 - 1;

/**
 * What the user sees from the two layers: the server's authoritative unread,
 * minus spaces a read request in flight covers. A space stays visible when
 * it has a message newer than what the pending read covers.
 */
export function visibleUnread(
  serverUnread: Record<string, SpaceUnread>,
  pendingReads: ReadonlyMap<string, string | null>,
): Record<string, SpaceUnread> {
  if (pendingReads.size === 0) return serverUnread;
  const out: Record<string, SpaceUnread> = {};
  for (const [space, entry] of Object.entries(serverUnread)) {
    const through = pendingReads.get(space);
    const covered =
      pendingReads.has(space) &&
      (through === null || compareRfc3339(through as string, entry.lastMessageTime) >= 0);
    if (!covered) out[space] = entry;
  }
  return out;
}

/** Whether read boundary `next` covers more than `prev` (null = everything). */
export function boundaryAdvances(next: string | null, prev: string | null): boolean {
  if (prev === null) return false;
  if (next === null) return true;
  return compareRfc3339(next, prev) > 0;
}

export function createChatPushStore(
  deps: { api: ChatPushApi; target?: EventTarget | null } = { api },
): ChatPushStore {
  // Two layers, never mixed:
  //   server - authoritative state, each part applied only when its server
  //            version is newer (see the module comment);
  //   local  - this tab's own guesses: a request found push unavailable, or a
  //            read is in flight. Each is dropped when the thing it guesses
  //            about is settled by the server, and never edits the server
  //            layer, so a server answer at an unchanged version still shows.
  // `state` is derived from both in recompute(), its only writer.
  let serverStatus: {
    configured: boolean;
    subscription: ChatPushSubscription | null;
    version: number;
  } = { configured: false, subscription: null, version: 0 };
  let serverUnread: UnreadModel = EMPTY_UNREAD_MODEL;
  let pushBlocked = false;
  const pendingReads = new Map<string, string | null>();
  const readAttempts = new Map<
    string,
    {
      readThrough: string | null;
      failures: number;
      inFlight: boolean;
      retryTimer: ReturnType<typeof setTimeout> | null;
    }
  >();
  let connected = false;

  let state: ChatPushState = EMPTY_CHAT_PUSH_STATE;
  const listeners = new Set<() => void>();
  let listening = false;
  // start() skips the sync only while the current server state says the
  // user is subscribed. It is derived, never latched: a failed request, a
  // missing grant, or the server clearing the subscription (access lost)
  // makes the next start() sync again, e.g. when the pane sees Chat access
  // restored.
  const subscribed = () =>
    !pushBlocked &&
    !!serverStatus.subscription &&
    (serverStatus.subscription.state === 'ACTIVE' ||
      serverStatus.subscription.state === 'SUSPENDED');
  let syncing: Promise<void> | null = null;
  let syncAgain = false;
  let expiryTimer: ReturnType<typeof setTimeout> | null = null;

  const clearExpiryTimer = () => {
    if (expiryTimer !== null) clearTimeout(expiryTimer);
    expiryTimer = null;
  };

  /**
   * The only writer of `state`: derives everything from the two layers and
   * the socket, re-derives `pushActive`, and re-arms the expiry timer from
   * the result, so no input can change without the decision following it.
   */
  const recompute = () => {
    const base = {
      configured: pushBlocked ? false : serverStatus.configured,
      subscription: pushBlocked ? null : serverStatus.subscription,
      connected,
      unread: visibleUnread(serverUnread.unread, pendingReads),
    };
    const pushActive = isPushActive(base);
    const next: ChatPushState = { ...base, pushActive };
    clearExpiryTimer();
    const expireAt = next.subscription?.expireTime ? Date.parse(next.subscription.expireTime) : NaN;
    if (pushActive && Number.isFinite(expireAt)) {
      expiryTimer = setTimeout(
        onExpiryTimer,
        Math.min(Math.max(expireAt - Date.now(), 0), MAX_TIMER_MS),
      );
    }
    const changed = (Object.keys(next) as Array<keyof ChatPushState>).some(
      (k) => next[k] !== state[k],
    );
    if (!changed) return;
    state = next;
    listeners.forEach((l) => l());
  };

  const setServerUnread = (model: UnreadModel) => {
    if (model === serverUnread) return;
    serverUnread = model;
    recompute();
  };

  /**
   * A server answer about the subscription. Newer state replaces the held
   * state. An answer at least as new as the held state also settles any
   * local "unavailable" guess, including one at the same version (the server
   * reporting unchanged ACTIVE after a failed request). An older answer
   * changes nothing.
   */
  const applyServerStatus = (status: {
    configured: boolean;
    subscription: ChatPushSubscription | null;
    version: unknown;
  }) => {
    const version = Number(status.version);
    if (!Number.isFinite(version) || version < serverStatus.version) return;
    if (version > serverStatus.version) {
      serverStatus = { configured: status.configured, subscription: status.subscription, version };
    }
    pushBlocked = false;
    recompute();
  };

  /** Local: a request found push unavailable (no access, refused, failed). */
  const blockPush = () => {
    pushBlocked = true;
    recompute();
  };

  const refreshUnread = async () => {
    try {
      const body = await deps.api.listGoogleChatUnread();
      const version = Number(body?.version);
      if (!Number.isFinite(version)) return;
      const spaces = (Array.isArray(body?.spaces) ? body.spaces : [])
        .map((s: any) => toSpaceUnread(s, s?.spaceName))
        .filter((s: SpaceUnread | null): s is SpaceUnread => !!s);
      setServerUnread(applyUnreadSnapshot(serverUnread, { spaces, version }));
    } catch {
      /* not signed in to Google, or offline: keep what we have */
    }
  };

  const applyEvent = (event: any) => {
    if (!event || typeof event.type !== 'string') return;
    if (event.type === 'google_chat_events_status') {
      applyServerStatus({
        configured: true,
        subscription: event.subscription ?? null,
        version: event.version,
      });
      return;
    }
    const update = unreadUpdateFromEvent(event);
    if (update) setServerUnread(applyVersionedUnread(serverUnread, update));
  };

  const runSync = async () => {
    await refreshUnread();
    let status: GoogleStatusLike = null;
    try {
      status = await deps.api.getGoogleStatus();
    } catch {
      return;
    }
    if (!status?.connected || !chatConsent(status).canRead) {
      blockPush();
      return;
    }
    let body: any;
    try {
      // Idempotent, and the authoritative subscription state: it also picks
      // up a suspension whose status event was missed, and renews one the
      // server let lapse.
      body = await deps.api.ensureGoogleChatSubscription();
    } catch {
      // Push unavailable (Google refused, API off): the pane keeps polling.
      blockPush();
      return;
    }
    applyServerStatus({
      configured: !!body?.configured,
      subscription: body?.subscription ?? null,
      version: body?.version,
    });
  };

  /** Re-read unread and subscription state now (coalesces overlapping calls). */
  const sync = (): Promise<void> => {
    if (syncing) {
      syncAgain = true;
      return syncing;
    }
    syncing = (async () => {
      try {
        do {
          syncAgain = false;
          await runSync();
        } while (syncAgain);
      } finally {
        syncing = null;
      }
    })();
    return syncing;
  };

  function onExpiryTimer() {
    expiryTimer = null;
    const wasActive = state.pushActive;
    recompute();
    // Expired without a renewal reaching us: poll, and ask the server, which
    // renews or recreates and reports the real state.
    if (wasActive && !state.pushActive) void sync();
  }

  const setConnected = (next: boolean) => {
    const reconnected = next && !connected;
    connected = next;
    recompute();
    if (!reconnected) return;
    // Re-read first, so a space cleared elsewhere meanwhile isn't re-sent.
    const resynced = listening ? sync() : Promise.resolve();
    void resynced.then(retryExhaustedReads);
  };

  const onWindowEvent = (e: Event) => applyEvent((e as CustomEvent).detail);

  const target = () => (deps.target === undefined ? globalThis.window : deps.target);

  const start = () => {
    const t = target();
    if (!listening && t) {
      t.addEventListener('google_chat_message', onWindowEvent);
      t.addEventListener('google_chat_unread', onWindowEvent);
      t.addEventListener('google_chat_events_status', onWindowEvent);
    }
    listening = true;
    if (subscribed()) return Promise.resolve();
    return syncing ?? sync();
  };

  /**
   * Mark-read is driven by the pane re-asking whenever the badge or the
   * loaded range changes, and a failed read itself changes the badge. So the
   * store owns retries: one attempt record per space, keyed by the read
   * boundary. Asking again for the same boundary never sends (after a
   * success, or while one is in flight or pending retry); failures retry
   * on a bounded backoff, then stop until the boundary moves (a newer message
   * loaded) or the socket reconnects.
   */
  const sendRead = async (spaceId: string, spaceName: string, readThrough: string | null) => {
    const attempt = readAttempts.get(spaceName);
    if (!attempt || attempt.readThrough !== readThrough) return;
    attempt.inFlight = true;
    // Local layer: hide what this read covers until the server answers.
    pendingReads.set(spaceName, readThrough);
    recompute();
    let settled = false;
    try {
      const body = await deps.api.markGoogleChatSpaceRead(spaceId, readThrough);
      const update = toSpaceUnread(body, body?.spaceName);
      if (update) {
        serverUnread = applyVersionedUnread(serverUnread, update);
        settled = true;
      }
    } catch {
      /* counted below */
    } finally {
      attempt.inFlight = false;
      if (pendingReads.get(spaceName) === readThrough) pendingReads.delete(spaceName);
      recompute();
    }
    if (readAttempts.get(spaceName) !== attempt) return;
    // Kept on success too: the server has this boundary, and messages past
    // it stay unread until a newer boundary is asked for.
    if (settled) return;
    attempt.failures += 1;
    // The server's state stands; re-read it so the badge is accurate.
    void refreshUnread();
    if (attempt.failures < MAX_READ_ATTEMPTS) {
      attempt.retryTimer = setTimeout(
        () => {
          attempt.retryTimer = null;
          if (readAttempts.get(spaceName) === attempt) {
            void sendRead(spaceId, spaceName, readThrough);
          }
        },
        READ_RETRY_BASE_MS * 2 ** (attempt.failures - 1),
      );
    }
  };

  /**
   * The user has seen `spaceId` through `readThrough` (null = everything).
   * Recorded whether or not a badge exists yet: a message can be on screen
   * before its push event arrives, and the server's read marker is what keeps
   * that event from counting it as unread. Boundaries only move forward; an
   * equal or older one is already covered by the attempt record.
   */
  const markRead = async (spaceId: string, readThrough: string | null) => {
    const spaceName = `spaces/${spaceId}`;
    const existing = readAttempts.get(spaceName);
    if (existing && !boundaryAdvances(readThrough, existing.readThrough)) return;
    if (existing?.retryTimer) clearTimeout(existing.retryTimer);
    readAttempts.set(spaceName, { readThrough, failures: 0, inFlight: false, retryTimer: null });
    await sendRead(spaceId, spaceName, readThrough);
  };

  /**
   * After a reconnect, re-send reads that ran out of attempts. They matter
   * even with no badge showing: the read marker is what stops a late push
   * event from counting a message the user already saw. The store owns this: the pane only re-asks when its
   * inputs change, and a reconnect with an unchanged badge changes none.
   * Reads that succeeded, or are in flight or waiting to retry, are left
   * alone.
   */
  const retryExhaustedReads = () => {
    for (const [spaceName, attempt] of readAttempts) {
      if (attempt.inFlight || attempt.retryTimer || attempt.failures < MAX_READ_ATTEMPTS) continue;
      const spaceId = spaceIdFromName(spaceName);
      if (!spaceId) {
        readAttempts.delete(spaceName);
        continue;
      }
      attempt.failures = 0;
      void sendRead(spaceId, spaceName, attempt.readThrough);
    }
  };

  const stop = () => {
    const t = target();
    if (listening && t) {
      t.removeEventListener('google_chat_message', onWindowEvent);
      t.removeEventListener('google_chat_unread', onWindowEvent);
      t.removeEventListener('google_chat_events_status', onWindowEvent);
    }
    listening = false;
    clearExpiryTimer();
    for (const attempt of readAttempts.values()) {
      if (attempt.retryTimer) clearTimeout(attempt.retryTimer);
    }
    readAttempts.clear();
  };

  return {
    getState: () => state,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    setConnected,
    start,
    sync,
    refreshUnread,
    markRead,
    applyEvent,
    stop,
  };
}

let shared: ChatPushStore | null = null;

export function chatPushStore(): ChatPushStore {
  shared ??= createChatPushStore({ api });
  return shared;
}

/** Drop the shared store (tests). */
export function resetChatPushStore(): void {
  shared?.stop();
  shared = null;
}

export function useGoogleChatPush(store: ChatPushStore = chatPushStore()): ChatPushState {
  return useSyncExternalStore(store.subscribe, store.getState, store.getState);
}

/**
 * Feed WebSocket connectivity to the store and start push once it is up.
 * Reconnects re-sync inside the store (setConnected).
 */
export function useGoogleChatPushBootstrap(
  connected: boolean,
  store: ChatPushStore = chatPushStore(),
): void {
  useEffect(() => {
    store.setConnected(connected);
    if (connected) void store.start();
  }, [connected, store]);
}
