import { useCallback, useEffect, useRef, useState } from 'react';
import type { FormEvent, KeyboardEvent, PointerEvent, WheelEvent } from 'react';
import { Globe, Loader2, RotateCw, X } from 'lucide-react';
import { getBrowserWsUrl } from '../utils/connection';
import {
  browserPaneStatusLabel,
  fitFrameInBox,
  keyInputFromDomEvent,
  mapPointerToViewport,
  normalizeUrlBarInput,
  type BrowserPaneFrame,
  type BrowserPaneStatus,
  type BrowserPaneViewport,
} from '@shared/utils/browserPaneInput';

const RECONNECT_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 10_000];
const POINTER_MOVE_MIN_INTERVAL_MS = 40;
const defaultWebSocketFactory = (url: string) => new WebSocket(url);

/**
 * Live view of the session's **public-web** Chromium — the browser the agent's
 * `browser` ReAct tool drives. Distinct from the preview pane on purpose: the
 * preview is the human's own iframe of the dev app (origin-pinned), this is a
 * screencast of the agent's internet browser. Both can exist for one session;
 * they never share cookies, history, or an input path.
 *
 * Input from this pane (click, type, scroll, URL bar) is forwarded to that
 * Chromium over `/api/sessions/:id/browser/ws`. The server refuses it while
 * the agent has a step in flight (`agent_busy`) and applies the same egress
 * policy the agent gets, so a human cannot steer the agent's browser to a
 * target the agent could not reach itself.
 */
export default function SessionBrowserPane({
  sessionId,
  onClose,
  webSocketFactory = defaultWebSocketFactory,
}: {
  sessionId: string;
  onClose?: () => void;
  webSocketFactory?: (url: string) => WebSocket;
}) {
  const socketRef = useRef<WebSocket | null>(null);
  const attachedRef = useRef(false);
  const reconnectAttemptRef = useRef(0);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const intentionalCloseRef = useRef(false);
  const connectRef = useRef<() => void>(() => {});
  const boxRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const lastMoveAtRef = useRef(0);
  const noticeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [status, setStatus] = useState<BrowserPaneStatus>('connecting');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [frame, setFrame] = useState<BrowserPaneFrame | null>(null);
  const [viewport, setViewport] = useState<BrowserPaneViewport | null>(null);
  const [pageUrl, setPageUrl] = useState<string | null>(null);
  const [urlInput, setUrlInput] = useState('');
  const [urlDirty, setUrlDirty] = useState(false);
  const [box, setBox] = useState({ width: 0, height: 0 });
  const [navigating, setNavigating] = useState(false);

  const showNotice = useCallback((text: string) => {
    setNotice(text);
    if (noticeTimerRef.current) clearTimeout(noticeTimerRef.current);
    noticeTimerRef.current = setTimeout(() => setNotice(''), 2_500);
  }, []);

  const sendFrame = useCallback((payload: Record<string, unknown>) => {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN || !attachedRef.current) return false;
    socket.send(JSON.stringify(payload));
    return true;
  }, []);

  const reconnectNow = useCallback(() => {
    if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
    reconnectTimerRef.current = null;
    reconnectAttemptRef.current = 0;
    const socket = socketRef.current;
    socketRef.current = null;
    intentionalCloseRef.current = false;
    socket?.close();
    connectRef.current();
  }, []);

  // Track the body box so frames render at the right size and pointer
  // coordinates can be mapped back to the Chromium viewport.
  useEffect(() => {
    const el = boxRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return undefined;
    const update = () => {
      const r = el.getBoundingClientRect();
      setBox({ width: Math.floor(r.width), height: Math.floor(r.height) });
    };
    const ro = new ResizeObserver(update);
    ro.observe(el);
    update();
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    intentionalCloseRef.current = false;
    attachedRef.current = false;
    reconnectAttemptRef.current = 0;
    setStatus('connecting');
    setError('');
    setFrame(null);
    setViewport(null);
    setPageUrl(null);
    setUrlDirty(false);

    const scheduleReconnect = () => {
      if (intentionalCloseRef.current || reconnectTimerRef.current) return;
      const attempt = reconnectAttemptRef.current;
      const delay = RECONNECT_DELAYS_MS[Math.min(attempt, RECONNECT_DELAYS_MS.length - 1)];
      reconnectAttemptRef.current += 1;
      reconnectTimerRef.current = setTimeout(() => {
        reconnectTimerRef.current = null;
        connectRef.current();
      }, delay);
    };

    const connect = () => {
      if (intentionalCloseRef.current) return;
      const socket = webSocketFactory(getBrowserWsUrl(sessionId));
      socketRef.current = socket;

      socket.onopen = () => {
        if (socketRef.current !== socket) return;
        setError('');
        attachedRef.current = true;
        socket.send(JSON.stringify({ type: 'attach', maxWidth: 1280, maxHeight: 800 }));
      };

      socket.onmessage = (event) => {
        if (socketRef.current !== socket) return;
        let msg: any;
        try {
          msg = JSON.parse(String(event.data));
        } catch {
          setStatus('error');
          setError('The browser server sent an invalid frame');
          return;
        }
        if (!msg || typeof msg.type !== 'string') return;
        if (msg.type === 'state') {
          reconnectAttemptRef.current = 0;
          const s = msg.status as 'waiting' | 'live' | 'closed';
          setStatus(s);
          setViewport(msg.viewport ?? null);
          setPageUrl(msg.url ?? null);
          if (s !== 'live') setFrame(null);
          return;
        }
        if (msg.type === 'frame') {
          setStatus('live');
          setFrame({
            data: msg.data,
            width: msg.width,
            height: msg.height,
            viewportWidth: msg.viewportWidth,
            viewportHeight: msg.viewportHeight,
          } as BrowserPaneFrame);
          if (msg.viewportWidth && msg.viewportHeight) {
            setViewport({ width: msg.viewportWidth, height: msg.viewportHeight });
          }
          if (typeof msg.url === 'string') setPageUrl(msg.url);
          return;
        }
        if (msg.type === 'input_result') {
          if (msg.ok === false) showNotice(msg.message || 'Input was not accepted');
          return;
        }
        if (msg.type === 'navigated') {
          setNavigating(false);
          if (msg.ok) {
            setUrlDirty(false);
            if (typeof msg.url === 'string') setPageUrl(msg.url);
          } else {
            showNotice(msg.message || 'Navigation refused');
          }
          return;
        }
        if (msg.type === 'error') {
          setStatus('error');
          setError(msg.message || 'Browser connection failed');
        }
      };

      socket.onclose = () => {
        if (socketRef.current !== socket) return;
        socketRef.current = null;
        attachedRef.current = false;
        if (intentionalCloseRef.current) return;
        setStatus('connecting');
        scheduleReconnect();
      };

      socket.onerror = () => {
        /* onclose follows and schedules the retry */
      };
    };

    connectRef.current = connect;
    connect();

    return () => {
      intentionalCloseRef.current = true;
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
      if (noticeTimerRef.current) clearTimeout(noticeTimerRef.current);
      const socket = socketRef.current;
      socketRef.current = null;
      attachedRef.current = false;
      socket?.close();
    };
  }, [sessionId, webSocketFactory, showNotice]);

  // Keep the URL bar in sync with the page unless the human is editing it.
  useEffect(() => {
    if (!urlDirty) setUrlInput(pageUrl ?? '');
  }, [pageUrl, urlDirty]);

  const rendered = fitFrameInBox(frame, box);
  const inputViewport: BrowserPaneViewport | null =
    viewport ?? (frame ? { width: frame.viewportWidth, height: frame.viewportHeight } : null);

  const pointerToViewport = (ev: PointerEvent<HTMLElement> | WheelEvent<HTMLElement>) => {
    const img = imgRef.current;
    if (!img) return null;
    const r = img.getBoundingClientRect();
    return mapPointerToViewport(
      { x: ev.clientX - r.left, y: ev.clientY - r.top },
      { width: r.width, height: r.height },
      inputViewport,
    );
  };

  const buttonName = (button: number): 'left' | 'right' | 'middle' =>
    button === 2 ? 'right' : button === 1 ? 'middle' : 'left';

  const onPointerDown = (ev: PointerEvent<HTMLDivElement>) => {
    ev.currentTarget.focus();
    const p = pointerToViewport(ev);
    if (!p) return;
    ev.preventDefault();
    sendFrame({
      type: 'input',
      input: { kind: 'mouse', type: 'down', ...p, button: buttonName(ev.button) },
    });
  };
  const onPointerUp = (ev: PointerEvent<HTMLDivElement>) => {
    const p = pointerToViewport(ev);
    if (!p) return;
    ev.preventDefault();
    sendFrame({
      type: 'input',
      input: { kind: 'mouse', type: 'up', ...p, button: buttonName(ev.button) },
    });
  };
  const onPointerMove = (ev: PointerEvent<HTMLDivElement>) => {
    const now = Date.now();
    if (now - lastMoveAtRef.current < POINTER_MOVE_MIN_INTERVAL_MS) return;
    // Only forward hover moves while a button is held (drag); idle hover
    // would flood the channel for no visible effect.
    if (ev.buttons === 0) return;
    const p = pointerToViewport(ev);
    if (!p) return;
    lastMoveAtRef.current = now;
    sendFrame({ type: 'input', input: { kind: 'mouse', type: 'move', ...p } });
  };
  const onWheel = (ev: WheelEvent<HTMLDivElement>) => {
    const p = pointerToViewport(ev);
    if (!p) return;
    ev.preventDefault();
    sendFrame({
      type: 'input',
      input: {
        kind: 'wheel',
        ...p,
        deltaX: Math.round(ev.deltaX),
        deltaY: Math.round(ev.deltaY),
      },
    });
  };
  const onKeyDown = (ev: KeyboardEvent<HTMLDivElement>) => {
    const input = keyInputFromDomEvent(ev);
    if (!input) return;
    ev.preventDefault();
    sendFrame({ type: 'input', input });
  };

  const submitUrl = (ev: FormEvent) => {
    ev.preventDefault();
    const url = normalizeUrlBarInput(urlInput);
    if (!url) return;
    if (!sendFrame({ type: 'navigate', url })) {
      showNotice('Not connected');
      return;
    }
    setNavigating(true);
  };

  const live = status === 'live';
  const statusText = browserPaneStatusLabel(status);

  return (
    <aside
      className="hidden lg:flex flex-col shrink-0 border-l border-gray-800 bg-gray-950 w-[640px] min-w-0"
      data-testid="session-browser-pane"
      aria-label="Agent browser"
    >
      <div className="flex items-center gap-2 px-3 py-2 border-b border-gray-800 bg-gray-900/80">
        <Globe size={15} className="shrink-0 text-sky-400" aria-hidden />
        <span className="text-sm font-semibold text-gray-100">Agent browser</span>
        <span
          className="text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded bg-sky-900/60 text-sky-200 border border-sky-800/70"
          title="This is the agent's public-internet browser, not the dev preview"
        >
          public web
        </span>
        <span
          className="flex-1 text-xs text-gray-500 truncate"
          data-testid="session-browser-status"
        >
          {live ? (
            <span className="inline-flex items-center gap-1">
              <span className="inline-block w-1.5 h-1.5 rounded-full bg-emerald-400" aria-hidden />
              {statusText}
            </span>
          ) : (
            statusText
          )}
        </span>
        <button
          type="button"
          onClick={reconnectNow}
          className="p-1 rounded text-gray-400 hover:text-gray-200 hover:bg-gray-800"
          title="Reconnect"
          aria-label="Reconnect agent browser"
        >
          <RotateCw size={14} />
        </button>
        {onClose && (
          <button
            type="button"
            onClick={onClose}
            className="p-1 rounded text-gray-400 hover:text-gray-200 hover:bg-gray-800"
            title="Close"
            aria-label="Close agent browser"
            data-testid="session-browser-close"
          >
            <X size={15} />
          </button>
        )}
      </div>

      <form
        onSubmit={submitUrl}
        className="flex items-center gap-2 px-3 py-1.5 border-b border-gray-800 bg-gray-900/40"
      >
        <input
          type="text"
          value={urlInput}
          onChange={(e) => {
            setUrlInput(e.target.value);
            setUrlDirty(true);
          }}
          onBlur={() => {
            if (urlInput.trim() === (pageUrl ?? '')) setUrlDirty(false);
          }}
          placeholder={live ? 'Enter a public URL' : 'No page yet'}
          disabled={!live}
          spellCheck={false}
          className="flex-1 min-w-0 bg-gray-950 border border-gray-800 rounded px-2 py-1 text-xs text-gray-200 font-mono placeholder:text-gray-600 focus:outline-none focus:border-sky-700 disabled:opacity-60"
          aria-label="Agent browser URL"
          data-testid="session-browser-url"
        />
        <button
          type="submit"
          disabled={!live || navigating}
          className="text-xs px-2 py-1 rounded bg-sky-800/70 hover:bg-sky-700/80 text-sky-100 border border-sky-700/60 disabled:opacity-50"
        >
          {navigating ? <Loader2 size={12} className="animate-spin" /> : 'Go'}
        </button>
      </form>

      {error ? (
        <div className="px-3 py-1.5 text-[11px] text-rose-300 bg-rose-950/40 border-b border-rose-900/50">
          {error}
        </div>
      ) : null}
      {notice ? (
        <div
          className="px-3 py-1.5 text-[11px] text-amber-200 bg-amber-950/40 border-b border-amber-900/50"
          data-testid="session-browser-notice"
        >
          {notice}
        </div>
      ) : null}

      <div
        ref={boxRef}
        tabIndex={0}
        role="application"
        aria-label="Agent browser viewport — click or type to act in the agent's browser"
        onPointerDown={onPointerDown}
        onPointerUp={onPointerUp}
        onPointerMove={onPointerMove}
        onWheel={onWheel}
        onKeyDown={onKeyDown}
        onContextMenu={(e) => e.preventDefault()}
        className="relative flex-1 min-h-0 flex items-center justify-center bg-black outline-none focus:ring-1 focus:ring-sky-700/70 select-none touch-none"
        data-testid="session-browser-viewport"
      >
        {live && frame ? (
          <img
            ref={imgRef}
            src={`data:image/jpeg;base64,${frame.data}`}
            alt="Live view of the agent's browser"
            draggable={false}
            width={rendered.width || undefined}
            height={rendered.height || undefined}
            style={rendered.width ? { width: rendered.width, height: rendered.height } : undefined}
            className="max-w-full max-h-full"
            data-testid="session-browser-frame"
          />
        ) : (
          <div className="px-6 text-center text-xs text-gray-500 space-y-2">
            {status === 'connecting' ? (
              <Loader2 size={18} className="mx-auto animate-spin text-sky-300" />
            ) : (
              <Globe size={22} className="mx-auto text-gray-700" aria-hidden />
            )}
            <p>{statusText}</p>
            {status === 'waiting' && (
              <p className="text-gray-600">
                The pane goes live the moment the agent runs a <code>browser</code> action.
              </p>
            )}
            {status === 'live' && !frame && (
              <p className="text-gray-600">Waiting for the first frame…</p>
            )}
          </div>
        )}
      </div>

      <div className="px-3 py-1 border-t border-gray-800 text-[10px] text-gray-600 truncate">
        Click, scroll, or type here to act in the agent&apos;s browser. Input is held while the
        agent is driving.
      </div>
    </aside>
  );
}
