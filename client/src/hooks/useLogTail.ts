/**
 * Live application-log tail hook (LOG-QUERY WebSocket contract).
 *
 * Wire protocol (server `websocket.ts`):
 *   → { type: 'logs_subscribe', projectId, cursor }
 *   ← { type: 'logs_tail_backfill', projectId, records[], cursor, nextCursor }
 *   ← { type: 'logs_tail',          projectId, records[], cursor, dropped }
 *   ← { type: 'logs_tail_recovery_required', projectId, dropped }  (then close 1013)
 *
 * The hook owns a dedicated socket so the tail is isolated from the main app
 * WebSocket. It reconnects with backoff, always re-subscribing from the last
 * durable cursor so a bounded-tail loss replays through backfill instead of
 * leaving a silent gap. `mergeTailRecords` dedupes replayed ids by id, so a
 * reconnect never doubles rows.
 *
 * Pausing freezes the visible list: incoming records buffer (bounded) and the
 * cursor still advances so reconnect math stays correct; resume merges them in.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { getWsUrl } from '../utils/connection';
import { mergeTailRecords, resolveTailCursor, type LogRecord } from '../utils/logStream';

export type LogTailStatus = 'connecting' | 'open' | 'reconnecting' | 'closed';

/** Minimal structural type so tests can inject a fake socket. */
export interface SocketLike {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  readyState: number;
  onopen: ((ev?: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev?: unknown) => void) | null;
  onerror: ((ev?: unknown) => void) | null;
}

export interface UseLogTailOptions {
  /** Max records retained in the visible tail (bounded client tail). */
  cap?: number;
  /** Base reconnect delay in ms (exponential backoff, capped). */
  reconnectBaseMs?: number;
  maxReconnectMs?: number;
  /** Socket factory — defaults to the real browser WebSocket at the /ws URL. */
  createSocket?: (url: string) => SocketLike;
  /**
   * Lower bound (nanoseconds) on the initial backfill window. Seeds the tail
   * with only recent records instead of the full retained history. Changing it
   * tears the socket down and re-seeds from the new window. Undefined = full
   * history ("All time").
   */
  sinceUnixNano?: number;
}

export interface UseLogTailResult {
  records: LogRecord[];
  status: LogTailStatus;
  /** Cumulative records the server told us were dropped (bounded-tail loss). */
  dropped: number;
  /** Dismiss the dropped-count notice once the user has acknowledged it. */
  clearDropped: () => void;
  paused: boolean;
  setPaused: (paused: boolean) => void;
  /** Buffered records waiting while paused. */
  pendingCount: number;
  /** Merge buffered records into the visible tail and stay live. */
  resume: () => void;
  /**
   * Empty the visible tail locally (after a server-side "Clear logs" purge).
   * Clears displayed + buffered records and rewinds the cursor so the socket
   * stays connected and only surfaces records ingested after the purge.
   */
  reset: () => void;
  error: string | null;
}

const DEFAULT_CAP = 1000;

function defaultCreateSocket(url: string): SocketLike {
  return new WebSocket(url) as unknown as SocketLike;
}

export function useLogTail(
  projectId: string | null | undefined,
  options: UseLogTailOptions = {},
): UseLogTailResult {
  const cap = options.cap ?? DEFAULT_CAP;
  const reconnectBaseMs = options.reconnectBaseMs ?? 500;
  const maxReconnectMs = options.maxReconnectMs ?? 8000;
  const createSocket = options.createSocket ?? defaultCreateSocket;
  const sinceUnixNano = options.sinceUnixNano;

  const [records, setRecords] = useState<LogRecord[]>([]);
  const [status, setStatus] = useState<LogTailStatus>('connecting');
  const [dropped, setDropped] = useState(0);
  const [paused, setPausedState] = useState(false);
  const [pendingCount, setPendingCount] = useState(0);
  const [error, setError] = useState<string | null>(null);

  // Refs survive reconnects without re-triggering the connect effect.
  const cursorRef = useRef(0);
  const pausedRef = useRef(false);
  const pendingRef = useRef<LogRecord[]>([]);
  const socketRef = useRef<SocketLike | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const attemptsRef = useRef(0);
  const closedRef = useRef(false);

  // Latest-value refs. The socket handlers and reconnect timers are long-lived
  // (a timer may fire seconds after the render that scheduled it), so they must
  // never close over a specific render's props. Reading current config through
  // refs keeps a reconnect bound to the *current* project/options rather than a
  // stale closure — the effect below still tears the socket down and reconnects
  // whenever `projectId` actually changes.
  const capRef = useRef(cap);
  capRef.current = cap;
  const createSocketRef = useRef(createSocket);
  createSocketRef.current = createSocket;
  const reconnectBaseMsRef = useRef(reconnectBaseMs);
  reconnectBaseMsRef.current = reconnectBaseMs;
  const maxReconnectMsRef = useRef(maxReconnectMs);
  maxReconnectMsRef.current = maxReconnectMs;
  const projectIdRef = useRef(projectId);
  projectIdRef.current = projectId;
  const sinceUnixNanoRef = useRef(sinceUnixNano);
  sinceUnixNanoRef.current = sinceUnixNano;

  // Mutually-recursive connect/scheduleReconnect, kept stable via refs so the
  // cycle needs no dependency array and no handler ever outlives its context.
  const connectRef = useRef<() => void>(() => {});
  const scheduleReconnectRef = useRef<() => void>(() => {});

  const applyIncoming = useCallback((incoming: LogRecord[], nextCursor: number) => {
    if (nextCursor > cursorRef.current) cursorRef.current = nextCursor;
    if (incoming.length === 0) return;
    if (pausedRef.current) {
      pendingRef.current = mergeTailRecords(pendingRef.current, incoming, capRef.current);
      setPendingCount(pendingRef.current.length);
      return;
    }
    setRecords((prev) => mergeTailRecords(prev, incoming, capRef.current));
  }, []);

  scheduleReconnectRef.current = () => {
    if (closedRef.current) return;
    if (reconnectTimerRef.current) return;
    const attempt = attemptsRef.current++;
    const delay = Math.min(maxReconnectMsRef.current, reconnectBaseMsRef.current * 2 ** attempt);
    reconnectTimerRef.current = setTimeout(() => {
      reconnectTimerRef.current = null;
      connectRef.current();
    }, delay);
  };

  connectRef.current = () => {
    const pid = projectIdRef.current;
    if (closedRef.current || !pid) return;
    let socket: SocketLike;
    try {
      socket = createSocketRef.current(getWsUrl());
    } catch (err) {
      setStatus('reconnecting');
      setError(err instanceof Error ? err.message : 'Log stream connection failed');
      scheduleReconnectRef.current();
      return;
    }
    socketRef.current = socket;

    socket.onopen = () => {
      attemptsRef.current = 0;
      setStatus('open');
      setError(null);
      try {
        const frame: Record<string, unknown> = {
          type: 'logs_subscribe',
          projectId: pid,
          cursor: cursorRef.current,
        };
        // Only bound the window on the initial seed (cursor 0). After the tail
        // has advanced, every id > cursor is already newer than the window, so
        // resubscribing with the (now-stale) bound would be a no-op anyway.
        if (sinceUnixNanoRef.current != null && cursorRef.current === 0) {
          frame.sinceUnixNano = sinceUnixNanoRef.current;
        }
        socket.send(JSON.stringify(frame));
      } catch {
        // A send failure on a freshly-open socket is a transport fault; the
        // close handler will schedule a reconnect from the same cursor.
      }
    };

    socket.onmessage = (ev: { data: unknown }) => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data));
      } catch {
        return;
      }
      // This socket only ever accepts frames for the project it subscribed to.
      if (msg.projectId && msg.projectId !== pid) return;
      const type = msg.type;
      if (type === 'logs_tail_backfill' || type === 'logs_tail') {
        const recs = Array.isArray(msg.records) ? (msg.records as LogRecord[]) : [];
        // Backfill frames advance by the server's `nextCursor` continue-token
        // (falling back to `cursor` on the final page / live frames), so a
        // reconnect never resubscribes from a stale page cursor and replays the
        // same backfill window. `applyIncoming` keeps the advance monotonic.
        const nextCursor = resolveTailCursor(msg, cursorRef.current);
        applyIncoming(recs, nextCursor);
        if (typeof msg.dropped === 'number' && msg.dropped > 0) {
          setDropped((d) => d + (msg.dropped as number));
        }
      } else if (type === 'logs_tail_recovery_required') {
        if (typeof msg.dropped === 'number' && msg.dropped > 0) {
          setDropped((d) => d + (msg.dropped as number));
        }
        // Server closes right after; reconnect replays from cursorRef.
      } else if (type === 'error') {
        setError(typeof msg.error === 'string' ? msg.error : 'Log stream error');
      }
    };

    socket.onerror = () => {
      // Surface nothing here; onclose drives the reconnect + status.
    };

    socket.onclose = () => {
      if (socketRef.current === socket) socketRef.current = null;
      if (closedRef.current) {
        setStatus('closed');
        return;
      }
      setStatus('reconnecting');
      scheduleReconnectRef.current();
    };
  };

  const setPaused = useCallback((next: boolean) => {
    pausedRef.current = next;
    setPausedState(next);
  }, []);

  const clearDropped = useCallback(() => setDropped(0), []);

  const resume = useCallback(() => {
    pausedRef.current = false;
    setPausedState(false);
    const buffered = pendingRef.current;
    pendingRef.current = [];
    setPendingCount(0);
    if (buffered.length > 0) {
      setRecords((prev) => mergeTailRecords(prev, buffered, capRef.current));
    }
  }, []);

  const reset = useCallback(() => {
    // Purge barrier for a destructive "Clear logs": the server store is now
    // empty, so we must tear the current socket down — detaching its handlers
    // first — and reconnect from a rewound cursor. Detaching `onmessage`
    // guarantees any `logs_tail` frame that was queued before/during the DELETE
    // can never land after this point and re-add now-deleted rows. The fresh
    // socket resubscribes from cursor 0 (the start of the now-empty history), so
    // the live view reflects only records ingested AFTER the purge.
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
    const sock = socketRef.current;
    socketRef.current = null;
    if (sock) {
      sock.onopen = sock.onmessage = sock.onclose = sock.onerror = null;
      try {
        sock.close();
      } catch {
        /* already closed */
      }
    }
    cursorRef.current = 0;
    pendingRef.current = [];
    attemptsRef.current = 0;
    setRecords([]);
    setPendingCount(0);
    setDropped(0);
    // Reconnect immediately unless the component is tearing down or has no
    // project (the mount effect owns connection in those cases).
    if (!closedRef.current && projectIdRef.current) {
      setStatus('connecting');
      connectRef.current();
    }
  }, []);

  useEffect(() => {
    closedRef.current = false;
    cursorRef.current = 0;
    pendingRef.current = [];
    attemptsRef.current = 0;
    setRecords([]);
    setPendingCount(0);
    setDropped(0);
    setError(null);
    if (!projectId) {
      setStatus('closed');
      return;
    }
    setStatus('connecting');
    connectRef.current();
    return () => {
      // Tear down before the next project connects. Setting closedRef first and
      // nulling the socket handlers means a late async `onclose` (real
      // WebSocket) can neither flip status nor schedule a cross-project
      // reconnect, and any pending reconnect timer is cleared here.
      closedRef.current = true;
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      const sock = socketRef.current;
      socketRef.current = null;
      if (sock) {
        sock.onopen = sock.onmessage = sock.onclose = sock.onerror = null;
        try {
          sock.close();
        } catch {
          /* already closed */
        }
      }
    };
    // `sinceUnixNano` is a primitive, so a changed time window tears the socket
    // down (cursor rewinds to 0 above) and re-seeds from the new window.
  }, [projectId, sinceUnixNano]);

  return {
    records,
    status,
    dropped,
    clearDropped,
    paused,
    setPaused,
    pendingCount,
    resume,
    reset,
    error,
  };
}
