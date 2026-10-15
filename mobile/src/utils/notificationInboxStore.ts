/**
 * The mobile bell inbox: one store shared by the header badge and the inbox
 * screen, fed by AppContext's WebSocket handler.
 *
 * Row and count state is the shared fact model in
 * `@shared/utils/notificationInbox` (the web bell uses the same one). This
 * module adds what the web bell keeps in component state: paging, the count
 * GET pump, optimistic read writes, and an account generation so responses
 * for a previous account never land.
 */
import {
  EMPTY_INBOX,
  beginCountRequest,
  countRequestOverlapsWrite,
  deriveInboxRows,
  deriveUnreadCount,
  needsCountRefresh,
  newestCreatedAt,
  pendingWriteCount,
  withCount,
  withCountResponse,
  withFirstPage,
  withLiveRow,
  withNextPage,
  withServerRead,
  withServerReadAll,
  withWrite,
  withWriteDone,
  withWriteFailed,
  type InboxFacts,
  type InboxNotification,
  type LocalWrite,
} from '@shared/utils/notificationInbox';

export const NOTIFICATION_PAGE_SIZE = 20;
export const NOTIFICATION_WS_EVENTS = new Set(['notification_created', 'notification_read']);
const MAX_STALE_COUNT_RETRIES = 5;

export interface NotificationInboxApi {
  list(params: {
    limit?: number;
    cursor?: string | null;
  }): Promise<{ items: InboxNotification[]; nextCursor: string | null }>;
  unreadCount(): Promise<{ count: number }>;
  markRead(id: string): Promise<object>;
  markAllRead(): Promise<object>;
}

export interface NotificationInboxSnapshot {
  /** False until an account is signed in and connected. */
  active: boolean;
  items: InboxNotification[];
  unreadCount: number;
  nextCursor: string | null;
  loaded: boolean;
  loading: boolean;
  error: string | null;
  actionError: string | null;
}

const EMPTY_SNAPSHOT: NotificationInboxSnapshot = {
  active: false,
  items: [],
  unreadCount: 0,
  nextCursor: null,
  loaded: false,
  loading: false,
  error: null,
  actionError: null,
};

/** Run an API call, turning a synchronous throw into a rejection. */
function call<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return Promise.resolve(fn());
  } catch (err) {
    return Promise.reject(err);
  }
}

export function badgeLabel(count: number): string {
  return count > 99 ? '99+' : String(count);
}

export function createNotificationInboxStore(api: NotificationInboxApi) {
  let enabled = false;
  let generation = 0;
  let facts: InboxFacts = EMPTY_INBOX;
  let nextCursor: string | null = null;
  let loaded = false;
  let loading = false;
  let error: string | null = null;
  let actionError: string | null = null;
  // A page request that resolves after a newer one must not apply.
  let pageSeq = 0;
  let countInFlight = false;
  let countWanted = false;
  let staleCountRetries = 0;
  let tokenSeq = 0;
  let snapshot: NotificationInboxSnapshot = EMPTY_SNAPSHOT;
  const listeners = new Set<() => void>();

  const publish = () => {
    const items = deriveInboxRows(facts);
    snapshot = {
      active: enabled,
      items,
      unreadCount: enabled ? deriveUnreadCount(facts, items) : 0,
      nextCursor,
      loaded,
      loading,
      error,
      actionError,
    };
    for (const l of listeners) l();
  };

  const update = (fn: (f: InboxFacts) => InboxFacts) => {
    facts = fn(facts);
    publish();
    pumpCount();
  };

  /**
   * Fetch the unread count when one was asked for, or when a settled write
   * isn't reflected in the badge yet. Never while one of our writes is in
   * flight: that response might or might not include the write.
   */
  function pumpCount() {
    if (!enabled || countInFlight || pendingWriteCount(facts) > 0) return;
    if (!countWanted && !needsCountRefresh(facts)) return;
    countWanted = false;
    countInFlight = true;
    const gen = generation;
    const req = beginCountRequest(facts);
    call(() => api.unreadCount())
      .then((r) => {
        if (gen !== generation) return;
        countInFlight = false;
        const next = withCountResponse(facts, req, r.count);
        if (next) {
          staleCountRetries = 0;
          update(() => next);
        } else if (countRequestOverlapsWrite(facts, req)) {
          countWanted = true;
          pumpCount();
        } else if (staleCountRetries < MAX_STALE_COUNT_RETRIES) {
          staleCountRetries += 1;
          countWanted = true;
          pumpCount();
        }
      })
      .catch(() => {
        if (gen === generation) countInFlight = false;
      });
  }

  function refreshCount() {
    countWanted = true;
    pumpCount();
  }

  async function loadPage(cursor: string | null): Promise<void> {
    if (!enabled) return;
    const gen = generation;
    const seq = ++pageSeq;
    loading = true;
    error = null;
    publish();
    try {
      const page = await call(() => api.list({ limit: NOTIFICATION_PAGE_SIZE, cursor }));
      if (gen !== generation || seq !== pageSeq) return;
      nextCursor = page.nextCursor;
      loaded = true;
      loading = false;
      update((f) => (cursor ? withNextPage(f, page.items) : withFirstPage(f, page.items)));
    } catch (err: any) {
      if (gen !== generation || seq !== pageSeq) return;
      error = err?.message || 'Could not load notifications';
      loading = false;
      publish();
    }
  }

  /** Overlay a read now, settle it when the server answers. */
  function runWrite(
    write: Omit<LocalWrite, 'token' | 'status' | 'reflected'>,
    request: () => Promise<object>,
    failure: string,
  ) {
    if (!enabled) return;
    const gen = generation;
    tokenSeq += 1;
    const token = `local-${tokenSeq}`;
    actionError = null;
    update((f) => withWrite(f, { ...write, token }));
    // The response's unreadCount is ignored: concurrent writes can answer out
    // of server order. Settling triggers a count GET instead.
    call(request)
      .then((r) => {
        if (gen !== generation) return;
        const readAt = (r as { readAt?: unknown }).readAt;
        update((f) => withWriteDone(f, token, typeof readAt === 'string' ? readAt : undefined));
      })
      .catch(() => {
        if (gen !== generation) return;
        actionError = failure;
        update((f) => withWriteFailed(f, token));
        refreshCount();
      });
  }

  return {
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getSnapshot(): NotificationInboxSnapshot {
      return snapshot;
    },
    /** Starts over for a (possibly different) account. */
    reset(nextEnabled: boolean) {
      generation += 1;
      enabled = nextEnabled;
      facts = EMPTY_INBOX;
      nextCursor = null;
      loaded = false;
      loading = false;
      error = null;
      actionError = null;
      countInFlight = false;
      countWanted = false;
      staleCountRetries = 0;
      publish();
      if (enabled) refreshCount();
    },
    /** After a reconnect: events missed meanwhile are not replayed. */
    resync() {
      if (!enabled) return;
      refreshCount();
      if (loaded) void loadPage(null);
    },
    refreshCount,
    /** Newest page; rows missed while away (or while the socket was down) show up. */
    loadFirstPage(): Promise<void> {
      refreshCount();
      return loadPage(null);
    },
    loadMore(): Promise<void> {
      if (!nextCursor || loading) return Promise.resolve();
      return loadPage(nextCursor);
    },
    markRead(n: InboxNotification) {
      if (n.readAt) return;
      runWrite(
        { kind: 'read', id: n.id, createdAt: n.createdAt },
        () => api.markRead(n.id),
        'Could not mark the notification read.',
      );
    },
    markAllRead() {
      runWrite(
        { kind: 'read_all', cutoff: newestCreatedAt(snapshot.items) },
        () => api.markAllRead(),
        'Could not mark notifications read.',
      );
    },
    dismissActionError() {
      actionError = null;
      publish();
    },
    /** Handles one `notification_created` / `notification_read` WS broadcast. */
    handleWsEvent(data: any) {
      if (!enabled || !data || typeof data !== 'object') return;
      const count = typeof data.unreadCount === 'number' ? data.unreadCount : undefined;
      // `inbox: false` is a desktop-only notice with no inbox row behind it.
      if (data.type === 'notification_created' && data.inbox !== false && data.notification?.id) {
        update((f) => withLiveRow(f, data.notification as InboxNotification, count));
      } else if (data.type === 'notification_read') {
        // Only the server's readAt may act as a mark-all cutoff; the device
        // clock can be ahead of it and would mark later rows read.
        const readAt = typeof data.readAt === 'string' ? data.readAt : null;
        if (data.all === true) {
          update((f) => (readAt ? withServerReadAll(f, readAt, count) : withCount(f, count)));
        } else if (Array.isArray(data.ids)) {
          update((f) => withServerRead(f, data.ids, readAt ?? 'read', count));
        }
      }
    },
  };
}

export type NotificationInboxStore = ReturnType<typeof createNotificationInboxStore>;
