/**
 * Live log tail (LOG-QUERY WebSocket), isolated from the main app socket.
 * Reconnects from the last cursor. `seed: true` is lossy (newest page only);
 * send it only while we hold no records.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  buildLogSubscribeFrame,
  mergeTailRecords,
  resolveTailCursor,
  type LogRecord,
} from '../utils/logTailWire';

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
  cap?: number;
  reconnectBaseMs?: number;
  maxReconnectMs?: number;
  getWsUrl: () => string;
  createSocket?: (url: string) => SocketLike;
  /** Lower bound (ns) on the initial backfill. Undefined = all time. Changing it reseeds. */
  sinceUnixNano?: number;
}

export interface UseLogTailResult {
  records: LogRecord[];
  status: LogTailStatus;
  dropped: number;
  clearDropped: () => void;
  paused: boolean;
  setPaused: (paused: boolean) => void;
  pendingCount: number;
  resume: () => void;
  /** Local clear after a server-side purge: rewind cursor, stay connected. */
  reset: () => void;
  error: string | null;
}

const DEFAULT_CAP = 1000;

function defaultCreateSocket(url: string): SocketLike {
  return new WebSocket(url) as unknown as SocketLike;
}

export function useLogTail(
  projectId: string | null | undefined,
  options: UseLogTailOptions,
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

  const cursorRef = useRef(0);
  // Not the same as cursor===0: an empty frame advances the cursor without rows.
  const hasRecordsRef = useRef(false);
  const pausedRef = useRef(false);
  const pendingRef = useRef<LogRecord[]>([]);
  const socketRef = useRef<SocketLike | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const attemptsRef = useRef(0);
  const closedRef = useRef(false);

  // Handlers/timers must not close over a stale render; the effect still
  // reconnects when `projectId` changes.
  const capRef = useRef(cap);
  capRef.current = cap;
  const createSocketRef = useRef(createSocket);
  createSocketRef.current = createSocket;
  const getWsUrlRef = useRef(options.getWsUrl);
  getWsUrlRef.current = options.getWsUrl;
  const reconnectBaseMsRef = useRef(reconnectBaseMs);
  reconnectBaseMsRef.current = reconnectBaseMs;
  const maxReconnectMsRef = useRef(maxReconnectMs);
  maxReconnectMsRef.current = maxReconnectMs;
  const projectIdRef = useRef(projectId);
  projectIdRef.current = projectId;
  const sinceUnixNanoRef = useRef(sinceUnixNano);
  sinceUnixNanoRef.current = sinceUnixNano;

  const connectRef = useRef<() => void>(() => {});
  const scheduleReconnectRef = useRef<() => void>(() => {});

  const applyIncoming = useCallback((incoming: LogRecord[], nextCursor: number) => {
    if (nextCursor > cursorRef.current) cursorRef.current = nextCursor;
    if (incoming.length === 0) return;
    hasRecordsRef.current = true;
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
      socket = createSocketRef.current(getWsUrlRef.current());
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
        socket.send(
          JSON.stringify(
            buildLogSubscribeFrame({
              projectId: pid,
              cursor: cursorRef.current,
              hasRecords: hasRecordsRef.current,
              sinceUnixNano: sinceUnixNanoRef.current,
            }),
          ),
        );
      } catch {
        // Close handler reconnects from the same cursor.
      }
    };

    socket.onmessage = (ev: { data: unknown }) => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data));
      } catch {
        return;
      }
      if (msg.projectId && msg.projectId !== pid) return;
      const type = msg.type;
      if (type === 'logs_tail_backfill' || type === 'logs_tail') {
        const recs = Array.isArray(msg.records) ? (msg.records as LogRecord[]) : [];
        const nextCursor = resolveTailCursor(msg, cursorRef.current);
        applyIncoming(recs, nextCursor);
        if (typeof msg.dropped === 'number' && msg.dropped > 0) {
          setDropped((d) => d + (msg.dropped as number));
        }
      } else if (type === 'logs_tail_recovery_required') {
        if (typeof msg.dropped === 'number' && msg.dropped > 0) {
          setDropped((d) => d + (msg.dropped as number));
        }
        // Server closes next; reconnect replays from cursorRef.
      } else if (type === 'error') {
        setError(typeof msg.error === 'string' ? msg.error : 'Log stream error');
      }
    };

    socket.onerror = () => {};

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
    // Detach handlers first so a queued logs_tail cannot re-add purged rows.
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
    hasRecordsRef.current = false;
    pendingRef.current = [];
    attemptsRef.current = 0;
    setRecords([]);
    setPendingCount(0);
    setDropped(0);
    if (!closedRef.current && projectIdRef.current) {
      setStatus('connecting');
      connectRef.current();
    }
  }, []);

  useEffect(() => {
    closedRef.current = false;
    cursorRef.current = 0;
    hasRecordsRef.current = false;
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
      // closedRef first so a late onclose cannot reconnect across projects.
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
    // Changing the time window reseeds from cursor 0.
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
