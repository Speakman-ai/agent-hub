import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import type { FormEvent, KeyboardEvent, PointerEvent, WheelEvent } from 'react';
import { Circle, Globe, KeyRound, Loader2, RotateCw, Square, Wand2, X } from 'lucide-react';
import { getBrowserWsUrl } from '../utils/connection';
import {
  BROWSER_LOGIN_BANNER_HINT,
  BROWSER_PANE_WAITING_HINT,
  browserLoginBannerTitle,
  browserPaneFrameSrc,
  browserPaneHasUrlBar,
  browserPaneStateKeepsFrame,
  browserPaneStatusLabel,
  browserPaneSurfaceBadge,
  browserPaneSurfaceDescription,
  fitFrameInBox,
  keyInputFromDomEvent,
  mapPointerToViewport,
  normalizeUrlBarInput,
  parseBrowserPaneFrameMime,
  parseBrowserPaneLoginRequest,
  parseBrowserPaneSurface,
  type BrowserPaneFrame,
  type BrowserPaneLoginRequest,
  type BrowserPaneStatus,
  type BrowserPaneSurface,
  type BrowserPaneViewport,
} from '@shared/utils/browserPaneInput';
import {
  BROWSER_PANE_RECORDING_IDLE,
  browserPaneRecordingSavedNotice,
  browserPaneSavedRecordingId,
  formatRecordingRemaining,
  parseBrowserPaneRecording,
  type BrowserPaneRecording,
} from '@shared/utils/browserPaneRecording';

const RoutineFromRecordingDialog = lazy(() => import('./RoutineFromRecordingDialog'));

const RECONNECT_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 10_000];
const POINTER_MOVE_MIN_INTERVAL_MS = 40;
const defaultWebSocketFactory = (url: string) => new WebSocket(url);

/**
 * Live view of what the agent is driving: its public-web Chromium (`browser`
 * tool), the origin-pinned preview drive (`preview` tool), or its Linux
 * desktop computer (`computer` tool; no URL bar). Distinct from the
 * iframe preview pane: that is the human's own view of the running app; this
 * is a screencast of the agent's Playwright session so you can watch it
 * click, screenshot, and verify. The pane follows whichever surface is
 * in use; they never share cookies, history, or an input path.
 *
 * Input from this pane (click, type, scroll, URL bar) is forwarded to that
 * Chromium over `/api/sessions/:id/browser/ws`. The server refuses it while
 * the agent has a step in flight (`agent_busy`) and applies the same URL
 * policy the agent gets on that surface.
 */
export default function SessionBrowserPane({
  sessionId,
  onClose,
  webSocketFactory = defaultWebSocketFactory,
  desktopOwnerLabel,
}: {
  sessionId: string;
  onClose?: () => void;
  webSocketFactory?: (url: string) => WebSocket;
  /** Whose desktop this is (organization agent chats); shown on the desktop surface. */
  desktopOwnerLabel?: string;
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
  const [surface, setSurface] = useState<BrowserPaneSurface | null>(null);
  // The socket handler's view of the current surface (state is stale in its closure).
  const surfaceRef = useRef<BrowserPaneSurface | null>(null);
  const [pageUrl, setPageUrl] = useState<string | null>(null);
  const [urlInput, setUrlInput] = useState('');
  const [urlDirty, setUrlDirty] = useState(false);
  const [box, setBox] = useState({ width: 0, height: 0 });
  const [navigating, setNavigating] = useState(false);
  const [loginRequest, setLoginRequest] = useState<BrowserPaneLoginRequest | null>(null);
  const [loginAnswering, setLoginAnswering] = useState(false);
  const [recording, setRecording] = useState<BrowserPaneRecording>(BROWSER_PANE_RECORDING_IDLE);
  const [recordingPending, setRecordingPending] = useState(false);
  // The last recording saved from this pane, offered to Make routine.
  const [savedRecordingId, setSavedRecordingId] = useState<string | null>(null);
  const [routineOpen, setRoutineOpen] = useState(false);
  const [clock, setClock] = useState(() => Date.now());

  const showNotice = useCallback((text: string, ms = 2_500) => {
    setNotice(text);
    if (noticeTimerRef.current) clearTimeout(noticeTimerRef.current);
    noticeTimerRef.current = setTimeout(() => setNotice(''), ms);
  }, []);

  // Tick the recording countdown once a second while recording.
  useEffect(() => {
    if (!recording.active) return undefined;
    setClock(Date.now());
    const t = setInterval(() => setClock(Date.now()), 1_000);
    return () => clearInterval(t);
  }, [recording.active]);

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
    setSurface(null);
    surfaceRef.current = null;
    setPageUrl(null);
    setUrlDirty(false);
    // Nothing from the previous session's surface may linger on this one.
    setLoginRequest(null);
    setSavedRecordingId(null);
    setNotice('');

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
        // The server re-sends an open sign-in request and an active recording on attach.
        setLoginRequest(null);
        setRecording(BROWSER_PANE_RECORDING_IDLE);
        setRecordingPending(false);
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
          const nextSurface = parseBrowserPaneSurface(msg.surface);
          if (!browserPaneStateKeepsFrame(surfaceRef.current, s, nextSurface)) setFrame(null);
          surfaceRef.current = nextSurface;
          setSurface(nextSurface);
          setPageUrl(msg.url ?? null);
          return;
        }
        if (msg.type === 'frame') {
          setStatus('live');
          setFrame({
            data: msg.data,
            mime: parseBrowserPaneFrameMime(msg.mime),
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
        if (msg.type === 'login_request') {
          setLoginRequest(parseBrowserPaneLoginRequest(msg.request));
          setLoginAnswering(false);
          return;
        }
        if (msg.type === 'login_result') {
          setLoginAnswering(false);
          if (msg.ok) setLoginRequest(null);
          else showNotice(msg.message || 'That sign-in request is no longer open');
          return;
        }
        if (msg.type === 'recording') {
          setRecording(parseBrowserPaneRecording(msg.state));
          setRecordingPending(false);
          return;
        }
        if (msg.type === 'recording_saved') {
          setRecordingPending(false);
          setSavedRecordingId(browserPaneSavedRecordingId(msg));
          showNotice(browserPaneRecordingSavedNotice(msg), 6_000);
          return;
        }
        if (msg.type === 'recording_error') {
          setRecordingPending(false);
          showNotice(msg.message || 'Recording failed', 6_000);
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

  const answerLogin = (kind: 'login_done' | 'login_cancel') => {
    if (!loginRequest) return;
    if (!sendFrame({ type: kind, requestId: loginRequest.requestId })) {
      showNotice('Not connected');
      return;
    }
    setLoginAnswering(true);
  };

  const toggleRecording = () => {
    if (!sendFrame({ type: recording.active ? 'record_stop' : 'record_start' })) {
      showNotice('Not connected');
      return;
    }
    setRecordingPending(true);
  };

  const live = status === 'live';
  const statusText = browserPaneStatusLabel(status);
  const surfaceBadge = browserPaneSurfaceBadge(surface);
  const isDesktop = surface === 'desktop';
  const canRecord = live && browserPaneHasUrlBar(surface);

  return (
    <aside
      className="hidden lg:flex flex-col shrink-0 border-l border-gray-800 bg-gray-950 w-[640px] min-w-0"
      data-testid="session-browser-pane"
      aria-label="Agent browser"
    >
      <div className="flex items-center gap-2 px-3 py-2 border-b border-gray-800 bg-gray-900/80">
        <Globe size={15} className="shrink-0 text-sky-400" aria-hidden />
        <span className="text-sm font-semibold text-gray-100">Agent browser</span>
        {surfaceBadge ? (
          <span
            className="text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded bg-sky-900/60 text-sky-200 border border-sky-800/70"
            data-testid="session-browser-surface"
            title={browserPaneSurfaceDescription(surface) ?? undefined}
          >
            {surfaceBadge}
          </span>
        ) : null}
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
        {recording.active ? (
          <button
            type="button"
            onClick={toggleRecording}
            disabled={recordingPending}
            className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded bg-rose-900/70 hover:bg-rose-800/80 text-rose-100 border border-rose-700/70 disabled:opacity-50"
            title="Stop recording and save it to Artifacts"
            aria-label="Stop recording"
            data-testid="session-browser-record-stop"
          >
            <Square size={10} className="fill-current" aria-hidden />
            <span>Stop</span>
            <span className="font-mono tabular-nums" data-testid="session-browser-record-remaining">
              {formatRecordingRemaining(recording, clock)}
            </span>
          </button>
        ) : canRecord ? (
          <button
            type="button"
            onClick={toggleRecording}
            disabled={recordingPending}
            className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded text-gray-300 hover:text-gray-100 hover:bg-gray-800 border border-gray-700 disabled:opacity-50"
            title="Record a demo: do the task once here and it is saved to Artifacts (up to 10 minutes)"
            aria-label="Record a demo"
            data-testid="session-browser-record"
          >
            <Circle size={10} className="fill-rose-500 text-rose-500" aria-hidden />
            Record
          </button>
        ) : null}
        {savedRecordingId && !recording.active && (
          <button
            type="button"
            onClick={() => setRoutineOpen(true)}
            className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded text-sky-200 hover:text-sky-100 hover:bg-sky-900/40 border border-sky-800/70"
            title="Have the agent turn your last recording into a skill you can schedule"
            aria-label="Make routine from the last recording"
            data-testid="session-browser-make-routine"
          >
            <Wand2 size={11} aria-hidden />
            Make routine
          </button>
        )}
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

      {isDesktop && desktopOwnerLabel ? (
        <div
          className="px-3 py-1 border-b border-gray-800 bg-gray-900/40 text-xs text-gray-400 truncate"
          data-testid="session-browser-desktop-owner"
        >
          {desktopOwnerLabel}
        </div>
      ) : null}

      {browserPaneHasUrlBar(surface) ? (
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
            placeholder={
              live
                ? surface === 'preview'
                  ? 'Enter a preview URL'
                  : 'Enter a public URL'
                : 'No page yet'
            }
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
      ) : null}

      {loginRequest ? (
        <div
          className="px-3 py-2 border-b border-amber-800/60 bg-amber-950/50 space-y-1.5"
          data-testid="session-browser-login-banner"
          role="status"
        >
          <div className="flex items-center gap-2 text-xs font-semibold text-amber-100">
            <KeyRound size={13} className="shrink-0 text-amber-300" aria-hidden />
            <span className="truncate">{browserLoginBannerTitle(loginRequest)}</span>
          </div>
          {loginRequest.reason ? (
            <p className="text-[11px] text-amber-200/90">{loginRequest.reason}</p>
          ) : null}
          <p className="text-[11px] text-amber-200/70">{BROWSER_LOGIN_BANNER_HINT}</p>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => answerLogin('login_done')}
              disabled={loginAnswering}
              className="text-xs px-2.5 py-1 rounded bg-emerald-700/80 hover:bg-emerald-600/80 text-emerald-50 border border-emerald-600/60 disabled:opacity-50"
              data-testid="session-browser-login-done"
            >
              Done
            </button>
            <button
              type="button"
              onClick={() => answerLogin('login_cancel')}
              disabled={loginAnswering}
              className="text-xs px-2.5 py-1 rounded bg-gray-800 hover:bg-gray-700 text-gray-200 border border-gray-700 disabled:opacity-50"
              data-testid="session-browser-login-cancel"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : null}
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
            src={browserPaneFrameSrc(frame)}
            alt={
              isDesktop ? "Live view of the agent's desktop" : "Live view of the agent's browser"
            }
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
            {status === 'waiting' && <p className="text-gray-600">{BROWSER_PANE_WAITING_HINT}</p>}
            {status === 'live' && !frame && (
              <p className="text-gray-600">Waiting for the first frame…</p>
            )}
          </div>
        )}
      </div>

      <div className="px-3 py-1 border-t border-gray-800 text-[10px] text-gray-600 truncate">
        {recording.active
          ? `Recording your clicks, typing and page changes (${recording.steps} step${recording.steps === 1 ? '' : 's'}). Password fields are masked.`
          : isDesktop
            ? "Click, scroll, or type here to use the agent's desktop. Input is held while the agent is acting."
            : "Click, scroll, or type here to act in the agent's browser. Input is held while the agent is driving."}
      </div>
      {routineOpen && savedRecordingId && (
        <Suspense fallback={null}>
          <RoutineFromRecordingDialog
            sessionId={sessionId}
            artifactId={savedRecordingId}
            onClose={() => setRoutineOpen(false)}
          />
        </Suspense>
      )}
    </aside>
  );
}
