import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { Repeat, X } from 'lucide-react';
import { api } from '../utils/api';
import {
  activeSessionPollers,
  EMPTY_POLLER_BANNER,
  pollerBannerReducer,
  pollerBannerSummary,
  SESSION_POLLER_REFRESH_MS,
  type SessionPoller,
} from '@shared/utils/sessionPoller';
import { SESSION_POLLER_WS_EVENT } from '../utils/sessionPollers';

/**
 * Running pollers for the open session, pinned above the transcript so the
 * user can see a recurring check is live and cancel it without scrolling back
 * to the card that started it.
 */
export default function SessionPollerBanner({ sessionId }: { sessionId: string }) {
  const [state, dispatch] = useReducer(pollerBannerReducer, EMPTY_POLLER_BANNER);
  const [stopping, setStopping] = useState<string | null>(null);
  const [error, setError] = useState('');
  // One counter orders every write and list request (see pollerBannerReducer).
  const stamp = useRef(0);
  const current = useRef(sessionId);
  current.current = sessionId;

  const write = useCallback((sid: string, poller: SessionPoller) => {
    if (current.current !== sid) return;
    dispatch({ type: 'write', sessionId: sid, poller, stamp: ++stamp.current });
  }, []);

  const load = useCallback(() => {
    const sid = sessionId;
    const mine = ++stamp.current;
    api
      .listSessionPollers(sid)
      .then((body) => {
        if (current.current !== sid) return;
        dispatch({ type: 'list', sessionId: sid, pollers: body?.pollers ?? [], stamp: mine });
      })
      // A failed read changes nothing; the interval below retries.
      .catch(() => {});
  }, [sessionId]);

  // Refresh on a fixed interval whatever the banner currently shows: a failed
  // first read or a missed push must not leave a running poller hidden.
  useEffect(() => {
    setError('');
    load();
    const timer = window.setInterval(load, SESSION_POLLER_REFRESH_MS);
    const onVisible = () => {
      if (document.visibilityState === 'visible') load();
    };
    window.addEventListener('focus', load);
    window.addEventListener('online', load);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('focus', load);
      window.removeEventListener('online', load);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [load]);

  useEffect(() => {
    const onUpdate = (event: Event) => {
      const detail = (event as CustomEvent).detail as {
        sessionId?: string;
        poller?: SessionPoller;
      };
      if (detail?.sessionId !== sessionId || !detail.poller) return;
      write(sessionId, detail.poller);
    };
    window.addEventListener(SESSION_POLLER_WS_EVENT, onUpdate);
    return () => window.removeEventListener(SESSION_POLLER_WS_EVENT, onUpdate);
  }, [sessionId, write]);

  const active = state.sessionId === sessionId ? activeSessionPollers(state.pollers) : [];
  const hasActive = active.length > 0;

  async function cancel(poller: SessionPoller) {
    const sid = sessionId;
    setStopping(poller.id);
    setError('');
    try {
      const body = await api.stopSessionPoller(sid, poller.id);
      if (body?.poller) write(sid, body.poller);
    } catch (err: any) {
      setError(err?.message || 'Could not cancel the poller.');
    } finally {
      setStopping(null);
    }
  }

  if (!hasActive) return null;

  return (
    <div
      className="shrink-0 border-b border-sky-800/50 bg-sky-950/40 px-3 py-2 space-y-1.5"
      data-testid="session-poller-banner"
    >
      {active.map((p) => (
        <div key={p.id} role="status" className="flex items-center gap-2 text-sm min-w-0">
          <Repeat size={14} className="text-sky-300 shrink-0 animate-pulse" />
          <div className="min-w-0 flex-1">
            <div className="truncate text-sky-100" title={p.task}>
              <span className="font-medium">Poller running:</span> {p.task}
            </div>
            <div className="truncate text-xs text-sky-100/70">{pollerBannerSummary(p)}</div>
          </div>
          <button
            type="button"
            onClick={() => cancel(p)}
            disabled={stopping === p.id}
            className="shrink-0 inline-flex items-center gap-1 rounded-md border border-sky-700/60 px-2.5 py-1 text-xs font-medium text-sky-100 hover:bg-sky-900/50 disabled:opacity-50"
          >
            <X size={12} />
            {stopping === p.id ? 'Cancelling...' : 'Cancel'}
          </button>
        </div>
      ))}
      {error && <p className="text-xs text-rose-200">{error}</p>}
    </div>
  );
}
