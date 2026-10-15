import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Bell, Loader2, Settings } from 'lucide-react';
import { api } from '../utils/api';
import { relativeTime } from '../utils/time';
import { placePopover, type PopoverPlacement } from '../utils/popoverPlacement';
import {
  notificationTarget,
  type InboxNotification,
  type NotificationTarget,
} from '../utils/notificationTarget';
import {
  EMPTY_INBOX,
  deriveInboxRows,
  deriveUnreadCount,
  pendingWriteCount,
  withFirstPage,
  withLiveRow,
  withNextPage,
  withServerRead,
  withServerReadAll,
  withWrite,
  withWriteDone,
  withWriteFailed,
  newestCreatedAt,
  withCount,
  beginCountRequest,
  needsCountRefresh,
  withCountResponse,
  countRequestOverlapsWrite,
  type InboxFacts,
  type LocalWrite,
} from '@shared/utils/notificationInbox';

/** App re-dispatches `notification_created` / `notification_read` WS frames on this event. */
export const NOTIFICATION_WS_EVENT = 'agenthub:notification';

export const NOTIFICATION_PAGE_SIZE = 20;

const POPOVER_WIDTH = 360;
const POPOVER_MAX_HEIGHT = 560;
const VIEWPORT_MARGIN = 8;
const MAX_STALE_COUNT_RETRIES = 5;

interface NotificationBellProps {
  onOpenTarget: (target: NotificationTarget) => void;
  onOpenSettings: () => void;
  /** Rail bells open to the right of the button instead of below it. */
  placement?: 'below' | 'right';
  testIdPrefix?: string;
}

/** Run an API call, turning a synchronous throw into a rejection so it can't crash a render. */
function call<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return Promise.resolve(fn());
  } catch (err) {
    return Promise.reject(err);
  }
}

function badgeLabel(count: number): string {
  return count > 99 ? '99+' : String(count);
}

export default function NotificationBell({
  onOpenTarget,
  onOpenSettings,
  placement = 'below',
  testIdPrefix = 'notification-bell',
}: NotificationBellProps) {
  const [open, setOpen] = useState(false);
  const [facts, setFactsState] = useState<InboxFacts>(EMPTY_INBOX);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [position, setPosition] = useState<PopoverPlacement | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  // A page request that resolves after a newer reset must not append stale rows.
  const requestSeq = useRef(0);
  // Mirrors `facts` so async callbacks read the latest without stale closures.
  const factsRef = useRef<InboxFacts>(EMPTY_INBOX);
  const countInFlight = useRef(false);
  const countWanted = useRef(false);
  const staleCountRetries = useRef(0);
  const tokenSeq = useRef(0);

  const updateFacts = useCallback((fn: (f: InboxFacts) => InboxFacts) => {
    factsRef.current = fn(factsRef.current);
    setFactsState(factsRef.current);
  }, []);

  const items = useMemo(() => deriveInboxRows(facts), [facts]);
  const unreadCount = deriveUnreadCount(facts, items);

  // Unique per write so a rollback only touches what that write marked.
  const optimisticToken = () => {
    tokenSeq.current += 1;
    return `local-${tokenSeq.current}`;
  };

  /**
   * Fetch the unread count when one was asked for, or when a settled write
   * isn't reflected in the badge's count yet. Never while one of our writes
   * is in flight: that response might or might not include the write.
   */
  const pumpCount = useCallback(() => {
    const f = factsRef.current;
    if (countInFlight.current || pendingWriteCount(f) > 0) return;
    if (!countWanted.current && !needsCountRefresh(f)) return;
    countWanted.current = false;
    countInFlight.current = true;
    const req = beginCountRequest(f);
    call(() => api.getNotificationUnreadCount())
      .then((r) => {
        countInFlight.current = false;
        const next = withCountResponse(factsRef.current, req, r.count);
        if (next) {
          staleCountRetries.current = 0;
          updateFacts(() => next);
        } else if (countRequestOverlapsWrite(factsRef.current, req)) {
          // Ask again; pumpCount holds the GET until the write settles.
          countWanted.current = true;
          pumpCount();
        } else if (staleCountRetries.current < MAX_STALE_COUNT_RETRIES) {
          // A newer count landed while this one was in flight; ask again.
          staleCountRetries.current += 1;
          countWanted.current = true;
          pumpCount();
        }
      })
      .catch(() => {
        countInFlight.current = false;
      });
  }, [updateFacts]);

  const refreshCount = useCallback(() => {
    countWanted.current = true;
    pumpCount();
  }, [pumpCount]);

  useEffect(() => {
    pumpCount();
  }, [facts, pumpCount]);

  useEffect(() => {
    refreshCount();
  }, [refreshCount]);

  const loadPage = useCallback(
    async (cursor: string | null) => {
      const seq = ++requestSeq.current;
      setLoading(true);
      setError(null);
      try {
        const page = await call(() =>
          api.listNotifications({ limit: NOTIFICATION_PAGE_SIZE, cursor }),
        );
        if (seq !== requestSeq.current) return;
        updateFacts((f) => (cursor ? withNextPage(f, page.items) : withFirstPage(f, page.items)));
        setNextCursor(page.nextCursor);
        setLoaded(true);
      } catch (err: any) {
        if (seq !== requestSeq.current) return;
        setError(err?.message || 'Could not load notifications');
      } finally {
        if (seq === requestSeq.current) setLoading(false);
      }
    },
    [updateFacts],
  );

  useEffect(() => {
    const handler = (e: Event) => {
      const data = (e as CustomEvent).detail;
      if (!data || typeof data !== 'object') return;
      const count = typeof data.unreadCount === 'number' ? data.unreadCount : undefined;
      // `inbox: false` is a desktop-only notice with no inbox row behind it.
      if (data.type === 'notification_created' && data.inbox !== false && data.notification?.id) {
        updateFacts((f) => withLiveRow(f, data.notification as InboxNotification, count));
      } else if (data.type === 'notification_read') {
        // Only the server's readAt may act as a mark-all cutoff; the browser
        // clock can be ahead of it and would mark later rows read.
        const readAt = typeof data.readAt === 'string' ? data.readAt : null;
        if (data.all === true) {
          updateFacts((f) => (readAt ? withServerReadAll(f, readAt, count) : withCount(f, count)));
        } else if (Array.isArray(data.ids)) {
          updateFacts((f) => withServerRead(f, data.ids, readAt ?? 'read', count));
        }
      }
    };
    window.addEventListener(NOTIFICATION_WS_EVENT, handler);
    return () => window.removeEventListener(NOTIFICATION_WS_EVENT, handler);
  }, [updateFacts]);

  // Every open starts from the newest page so rows missed while closed (or
  // while the socket was down) show up.
  useEffect(() => {
    if (!open) return;
    refreshCount();
    void loadPage(null);
  }, [open, loadPage, refreshCount]);

  useLayoutEffect(() => {
    if (!open || !buttonRef.current) return;
    const place = () => {
      setPosition(
        placePopover(
          buttonRef.current!.getBoundingClientRect(),
          { width: window.innerWidth, height: window.innerHeight },
          placement,
          {
            preferredWidth: POPOVER_WIDTH,
            preferredHeight: POPOVER_MAX_HEIGHT,
            margin: VIEWPORT_MARGIN,
          },
        ),
      );
    };
    place();
    window.addEventListener('resize', place);
    return () => window.removeEventListener('resize', place);
  }, [open, placement]);

  useEffect(() => {
    if (!open) return;
    const onPointer = (e: MouseEvent) => {
      const t = e.target as Node;
      if (popoverRef.current?.contains(t) || buttonRef.current?.contains(t)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  /** Run a read write: overlay it now, settle it when the server answers. */
  const runWrite = (
    write: Omit<LocalWrite, 'token' | 'status' | 'reflected'>,
    request: () => Promise<object>,
    failure: string,
  ) => {
    const token = optimisticToken();
    setActionError(null);
    updateFacts((f) => withWrite(f, { ...write, token }));
    // The response's unreadCount is ignored on purpose: concurrent writes can
    // answer out of server order. Settling triggers a count GET instead.
    call(request)
      .then((r) => {
        const readAt = (r as { readAt?: unknown }).readAt;
        updateFacts((f) =>
          withWriteDone(f, token, typeof readAt === 'string' ? readAt : undefined),
        );
      })
      .catch(() => {
        updateFacts((f) => withWriteFailed(f, token));
        setActionError(failure);
        refreshCount();
      });
  };

  const handleRowClick = (n: InboxNotification) => {
    if (!n.readAt) {
      runWrite(
        { kind: 'read', id: n.id, createdAt: n.createdAt },
        () => api.markNotificationRead(n.id),
        'Could not mark the notification read.',
      );
    }
    const target = notificationTarget(n);
    if (target) {
      setOpen(false);
      onOpenTarget(target);
    }
  };

  const handleMarkAllRead = () => {
    runWrite(
      { kind: 'read_all', cutoff: newestCreatedAt(items) },
      () => api.markAllNotificationsRead(),
      'Could not mark notifications read.',
    );
  };

  const handleScroll = (e: React.UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    if (!nextCursor || loading) return;
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 48) void loadPage(nextCursor);
  };

  const label = unreadCount > 0 ? `Notifications, ${unreadCount} unread` : 'Notifications';

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="relative flex-shrink-0 text-gray-400 hover:text-white p-2 min-w-[36px] min-h-[36px] flex items-center justify-center rounded-lg hover:bg-gray-800 transition-colors"
        title="Notifications"
        aria-label={label}
        aria-haspopup="dialog"
        aria-expanded={open}
        data-testid={testIdPrefix}
      >
        <Bell size={18} />
        {unreadCount > 0 && (
          <span
            className="absolute top-0.5 right-0.5 min-w-[16px] h-4 px-1 rounded-full bg-indigo-500 text-white text-[10px] font-semibold leading-4 text-center"
            data-testid={`${testIdPrefix}-badge`}
          >
            {badgeLabel(unreadCount)}
          </span>
        )}
      </button>
      {open &&
        position &&
        createPortal(
          <div
            ref={popoverRef}
            role="dialog"
            aria-label="Notifications"
            className="fixed z-[100] flex flex-col rounded-xl border border-gray-700 bg-gray-900 shadow-2xl overflow-hidden"
            style={{
              top: position.top,
              bottom: position.bottom,
              left: position.left,
              width: position.width,
              maxHeight: position.maxHeight,
            }}
            data-testid={`${testIdPrefix}-popover`}
          >
            <div className="flex flex-shrink-0 items-center justify-between px-4 py-3 border-b border-gray-800">
              <span className="text-sm font-semibold text-gray-100">Notifications</span>
              <button
                type="button"
                onClick={handleMarkAllRead}
                disabled={unreadCount === 0 && !items.some((n) => !n.readAt)}
                className="text-xs text-indigo-400 hover:text-indigo-300 disabled:text-gray-600 disabled:cursor-default"
                data-testid={`${testIdPrefix}-mark-all`}
              >
                Mark all read
              </button>
            </div>
            {actionError && (
              <div
                role="alert"
                className="flex flex-shrink-0 items-center justify-between gap-2 px-4 py-2 text-xs text-red-300 bg-red-950/40 border-b border-red-900/50"
                data-testid={`${testIdPrefix}-action-error`}
              >
                <span>{actionError}</span>
                <button
                  type="button"
                  onClick={() => setActionError(null)}
                  className="text-red-400 hover:text-red-200"
                  aria-label="Dismiss"
                >
                  ×
                </button>
              </div>
            )}
            <div className="flex-1 overflow-y-auto min-h-0" onScroll={handleScroll}>
              {items.length === 0 && loaded && !error && (
                <p className="px-4 py-8 text-center text-sm text-gray-500">
                  You&apos;re all caught up.
                </p>
              )}
              {items.length === 0 && error && (
                <p className="px-4 py-8 text-center text-sm text-red-400">{error}</p>
              )}
              <ul>
                {items.map((n) => {
                  const unread = !n.readAt;
                  return (
                    <li key={n.id}>
                      <button
                        type="button"
                        onClick={() => handleRowClick(n)}
                        className={`w-full text-left px-4 py-3 border-b border-gray-800/70 border-l-2 hover:bg-gray-800/60 transition-colors ${
                          unread ? 'border-l-indigo-500 bg-gray-800/30' : 'border-l-transparent'
                        }`}
                        data-testid="notification-row"
                        data-unread={unread ? 'true' : 'false'}
                      >
                        <div className="flex items-baseline gap-2">
                          <span
                            className={`flex-1 min-w-0 truncate text-sm ${
                              unread ? 'font-semibold text-gray-100' : 'text-gray-300'
                            }`}
                          >
                            {n.title}
                          </span>
                          <time
                            className="flex-shrink-0 text-[11px] text-gray-500"
                            dateTime={n.createdAt}
                            title={new Date(n.createdAt).toLocaleString()}
                          >
                            {relativeTime(n.createdAt)}
                          </time>
                        </div>
                        {n.body && (
                          <p className="mt-0.5 text-xs text-gray-400 line-clamp-2">{n.body}</p>
                        )}
                      </button>
                    </li>
                  );
                })}
              </ul>
              {loading && (
                <div className="flex justify-center py-3 text-gray-500">
                  <Loader2 size={16} className="animate-spin" />
                </div>
              )}
              {!loading && nextCursor && (
                <button
                  type="button"
                  onClick={() => void loadPage(nextCursor)}
                  className="w-full py-2.5 text-xs text-gray-400 hover:text-white hover:bg-gray-800/60"
                  data-testid={`${testIdPrefix}-load-more`}
                >
                  Load more
                </button>
              )}
              {items.length > 0 && error && (
                <p className="px-4 py-2 text-center text-xs text-red-400">{error}</p>
              )}
            </div>
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                onOpenSettings();
              }}
              className="flex flex-shrink-0 items-center justify-center gap-1.5 px-4 py-2.5 border-t border-gray-800 text-xs text-gray-400 hover:text-white hover:bg-gray-800/60"
              data-testid={`${testIdPrefix}-settings`}
            >
              <Settings size={13} />
              Notification settings
            </button>
          </div>,
          document.body,
        )}
    </>
  );
}
