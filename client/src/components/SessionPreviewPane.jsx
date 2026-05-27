import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import {
  Square,
  RefreshCw,
  Copy,
  X,
  Maximize2,
  Loader2,
  AlertCircle,
  CheckCircle2,
  ArrowLeftCircle,
  GripVertical,
} from 'lucide-react';
import {
  derivePaneState,
  createActivityTouch,
  clampPaneWidth,
  paneWidthStorageKey,
  DEFAULT_PANE_WIDTH,
  previewIframeSrc,
  previewProxySessionIdFromUrl,
  resolvePreviewBrowserUrl,
  withPreviewTicket,
} from '../utils/sessionPreviewState.js';
import { getApiBase, getAuthHeaders } from '../utils/connection.js';

/**
 * SessionPreviewPane
 *
 * Persistent preview surface attached to a session. Reads the latest
 * `agenthub_preview` WS event for the active session (parent feeds it
 * via the `event` prop), renders the running app in an iframe, and lets
 * the user pop it out into a detached window for side-by-side work.
 *
 * State machine (driven by `derivePaneState`):
 *   idle         → "no preview yet — ask the agent" placeholder
 *   starting     → spinner + 'starting' pill
 *   ready        → iframe + URL bar + refresh / pop-out / stop
 *   failed       → log tail + retry hint
 *   unavailable  → wizard CTA (preview disabled / not configured)
 *
 * Popped-out mode:
 *   - Web: opens `window.open(url, name, features)` and switches the
 *     pane to a reattach placeholder. Closing the window auto-reattaches
 *     via a `window.closed` poll.
 *   - Electron: hits `window.electronAPI.popOutPreview({...})` which
 *     opens a dedicated BrowserWindow. The browser's `window.open` path
 *     remains as a safety fallback if the IPC bridge is missing.
 *
 * Activity touch:
 *   focus/blur/mousemove inside the iframe fire a throttled `onTouch`
 *   call (30 s window). The handler is wired by the parent to a POST to
 *   the runtime touch endpoint so the idle-TTL reaper doesn't kill an
 *   actively-used preview.
 */
export default function SessionPreviewPane({
  sessionId,
  event,
  onClose,
  onTouch,
  onStop,
  onConfigure,
  onPopOut,
  popOut, // optional injectable for tests — defaults to window.open
  electronApi, // optional injectable for tests — defaults to window.electronAPI
  // Boot logs stay open by default when we have lines (user can collapse).
  defaultFooterOpen = false,
}) {
  const state = useMemo(() => derivePaneState(event), [event]);
  const bootLogRef = useRef(null);
  const [iframeKey, setIframeKey] = useState(0);
  const [copied, setCopied] = useState(false);
  // 'browser' — window.open pop-out, tracked via poppedWindowRef.
  // 'electron' — IPC-owned BrowserWindow, no JS handle; we never get closed
  //              events, so the user reattaches manually or via the button.
  // null       — not popped out.
  const [popMode, setPopMode] = useState(null);
  const hasBootLog = Array.isArray(state.logTail) && state.logTail.length > 0;
  const [footerOpen, setFooterOpen] = useState(defaultFooterOpen || hasBootLog);

  useEffect(() => {
    if (hasBootLog) setFooterOpen(true);
  }, [hasBootLog, state.status]);

  useEffect(() => {
    const el = bootLogRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [state.logTail, state.status, footerOpen]);
  const [isResizing, setIsResizing] = useState(false);
  const poppedWindowRef = useRef(null);

  // Wildcard subdomain base for "subdomain preview" mode (Phase 4 of
  // the session-previews RFC). Fetched once from /api/config; null
  // while loading or when the server has it unset (path-prefix mode).
  // Used to decide whether resolvePreviewBrowserUrl returns a
  // subdomain URL or a Hub-origin path-prefix URL.
  // Sentinel distinguishing "still loading" from "server says no subdomain
  // mode". Without this the browserPreviewUrl memo fires with null on the
  // first render, computes the path-prefix URL, the ticket-mint effect
  // consumes a single-use ticket on the path-prefix origin, and by the time
  // the fetch resolves and previewSubdomainBase flips to the real value the
  // ticket is gone and the cookie lives on the wrong origin → white screen.
  const SUBDOMAIN_LOADING = 'loading';
  const [previewSubdomainBase, setPreviewSubdomainBase] = useState(SUBDOMAIN_LOADING);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch(`${getApiBase()}/config`, {
          headers: getAuthHeaders(),
        });
        if (!r.ok) {
          if (!cancelled) setPreviewSubdomainBase(null);
          return;
        }
        const cfg = await r.json();
        if (cancelled) return;
        setPreviewSubdomainBase(
          typeof cfg.previewSubdomainBase === 'string' && cfg.previewSubdomainBase
            ? cfg.previewSubdomainBase
            : null,
        );
      } catch {
        if (!cancelled) setPreviewSubdomainBase(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Resizable width — persisted per session in localStorage.
  const widthKey = paneWidthStorageKey(sessionId);
  const [width, setWidth] = useState(() => {
    if (!widthKey) return DEFAULT_PANE_WIDTH;
    try {
      return clampPaneWidth(window.localStorage.getItem(widthKey));
    } catch {
      return DEFAULT_PANE_WIDTH;
    }
  });

  useEffect(() => {
    if (!widthKey) {
      setWidth(DEFAULT_PANE_WIDTH);
      return;
    }
    try {
      setWidth(clampPaneWidth(window.localStorage.getItem(widthKey)));
    } catch {
      setWidth(DEFAULT_PANE_WIDTH);
    }
  }, [widthKey]);

  useEffect(() => {
    if (!widthKey) return;
    try {
      window.localStorage.setItem(widthKey, String(width));
    } catch {
      // Storage failures (private mode, quota) are non-fatal — width
      // just won't survive reload.
    }
  }, [widthKey, width]);

  const dragStateRef = useRef(null);
  const endResize = useCallback(() => {
    dragStateRef.current = null;
    setIsResizing(false);
  }, []);

  const onResizePointerDown = useCallback(
    (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      dragStateRef.current = { startX: e.clientX, startWidth: width };
      setIsResizing(true);
      try {
        e.currentTarget.setPointerCapture(e.pointerId);
      } catch {
        /* unsupported in some test environments */
      }
    },
    [width],
  );

  const onResizePointerMove = useCallback((e) => {
    if (!dragStateRef.current) return;
    const { startX, startWidth } = dragStateRef.current;
    // Pane is on the right — drag the left edge leftward to widen.
    setWidth(clampPaneWidth(startWidth + (startX - e.clientX)));
  }, []);

  useEffect(() => {
    if (!isResizing) return undefined;
    const prev = document.body.style.userSelect;
    document.body.style.userSelect = 'none';
    return () => {
      document.body.style.userSelect = prev;
    };
  }, [isResizing]);

  // Reset iframe + popped state when the active preview rotates (different
  // previewId — fresh boot in the same pane).
  const previewId = state.status === 'ready' ? state.previewId : null;
  useEffect(() => {
    setIframeKey(0);
    setCopied(false);
    // Don't auto-reattach a popped window on previewId change — the
    // detached window is keyed by sessionId and would now host a stale
    // URL. The poll-loop below picks up `window.closed` and clears.
  }, [previewId]);

  // Worktree edits while preview is up — soft-reload iframe (ng serve HMR
  // often updates without this; reload covers proxy/API staleness).
  const refreshAt = event?.refreshAt;
  const browserPreviewUrl = useMemo(() => {
    if (state.status !== 'ready' || !state.url) return '';
    // Local-dev URLs (`http://localhost:<port>`) bypass Hub proxy/subdomain
    // routing — safe to render immediately without waiting on /api/config.
    if (!previewProxySessionIdFromUrl(state.url)) {
      return state.url;
    }
    // Hub-proxied URLs need subdomain vs path-prefix resolution — block until
    // the /api/config fetch resolves so we don't race (SUBDOMAIN_LOADING).
    if (previewSubdomainBase === SUBDOMAIN_LOADING) {
      return '';
    }
    return resolvePreviewBrowserUrl(state.url, {
      subdomainBase: previewSubdomainBase,
    });
  }, [state.status, state.url, previewSubdomainBase]);

  const baseIframeSrc = useMemo(() => {
    if (!browserPreviewUrl) return '';
    const bust = refreshAt ?? iframeKey;
    return previewIframeSrc(browserPreviewUrl, bust);
  }, [browserPreviewUrl, refreshAt, iframeKey]);

  // Hub-proxied preview URLs (remote browser deployments) cannot load
  // in an iframe with just localStorage-stored JWTs — the browser
  // can't attach Authorization headers to a top-level iframe nav. We
  // mint a single-use ticket (POST /api/sessions/:id/preview/ticket
  // with our JWT), append it to the iframe `src`, and the server's
  // auth middleware consumes the ticket and writes a path-scoped
  // HttpOnly cookie so sub-resources authenticate automatically. See
  // server/preview-auth.ts for the full rationale.
  //
  // Local-dev URLs (`http://localhost:<port>`) skip this entirely —
  // the iframe hits the dev server directly, bypassing Hub auth.
  const proxySessionId = useMemo(
    () => previewProxySessionIdFromUrl(baseIframeSrc),
    [baseIframeSrc],
  );
  // Local-dev URLs (`http://localhost:<port>`) can be rendered
  // synchronously on the first render — no ticket is needed. Hub-
  // proxy URLs render with `''` first and the effect below swaps in
  // the ticketed URL when the mint resolves. Keep these distinct so
  // existing tests that assert on local-dev iframe src still see the
  // value on the initial render.
  const [ticketedSrc, setTicketedSrc] = useState(() =>
    baseIframeSrc && !proxySessionId ? baseIframeSrc : '',
  );

  useEffect(() => {
    let cancelled = false;
    if (!baseIframeSrc) {
      setTicketedSrc('');
      return () => {
        cancelled = true;
      };
    }
    if (!proxySessionId) {
      // Local-dev path — no ticket needed.
      setTicketedSrc(baseIframeSrc);
      return () => {
        cancelled = true;
      };
    }
    // Hub-proxied — mint a fresh ticket per top-level nav. Sub-
    // resources will ride along on the path-scoped cookie the proxy
    // writes back on the response.
    (async () => {
      try {
        const res = await fetch(`${getApiBase()}/sessions/${proxySessionId}/preview/ticket`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...getAuthHeaders(),
          },
          body: '{}',
        });
        if (!res.ok) {
          throw new Error(`Ticket mint failed: ${res.status}`);
        }
        const body = await res.json();
        if (cancelled) return;
        setTicketedSrc(withPreviewTicket(baseIframeSrc, body.ticket));
      } catch (err) {
        if (cancelled) return;
        // Fall back to the base URL anyway — the browser will hit the
        // proxy and get 401, which the SPA's 401 handler will surface
        // via the standard auth-trap reload. Better than a blank pane.
        console.warn('[preview] ticket mint failed; loading iframe without it', err);
        setTicketedSrc(baseIframeSrc);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [baseIframeSrc, proxySessionId]);

  const iframeSrc = ticketedSrc;
  useEffect(() => {
    if (state.status !== 'ready' || refreshAt == null) return;
    setIframeKey((k) => k + 1);
  }, [refreshAt, state.status]);

  // Poll the browser pop-out window for closure so we reattach automatically.
  // Only runs for the 'browser' path — the Electron path has no JS window
  // handle to poll, and checking poppedWindowRef.current === null would
  // immediately snap the pane back to inline mode.
  useEffect(() => {
    if (popMode !== 'browser') return undefined;
    const id = setInterval(() => {
      const w = poppedWindowRef.current;
      if (!w || w.closed) {
        poppedWindowRef.current = null;
        setPopMode(null);
      }
    }, 1000);
    return () => clearInterval(id);
  }, [popMode]);

  // Build a throttled activity-touch caller. Recreate the throttle when
  // the previewId rotates so a fresh boot starts with a clean 30 s window.
  const touchFn = useMemo(
    () =>
      createActivityTouch(() => {
        if (state.status === 'ready' && typeof onTouch === 'function') {
          onTouch({ sessionId, previewId: state.previewId });
        }
      }, 30_000),
    // We intentionally depend on previewId/sessionId/onTouch so a new
    // closure captures the latest values for each rotation.
    [sessionId, state.previewId, state.status, onTouch],
  );

  const handleRefresh = useCallback(() => {
    setIframeKey((k) => k + 1);
  }, []);

  const handleCopyUrl = useCallback(async () => {
    if (state.status !== 'ready' || !browserPreviewUrl) return;
    try {
      await navigator.clipboard.writeText(browserPreviewUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Permission denied — silently ignore; the link is still visible.
    }
  }, [state.status, browserPreviewUrl]);

  const handlePopOut = useCallback(() => {
    if (state.status !== 'ready' || !browserPreviewUrl) return;
    if (typeof onPopOut === 'function') {
      onPopOut({ sessionId, previewId: state.previewId, url: browserPreviewUrl });
    }
    const api = electronApi ?? (typeof window !== 'undefined' ? window.electronAPI : null);
    if (api && typeof api.popOutPreview === 'function') {
      api.popOutPreview({ sessionId, url: browserPreviewUrl });
      // The Electron main process owns the BrowserWindow lifecycle; there is
      // no JS window handle to poll. Set popMode to 'electron' so the poll
      // loop (which would immediately see poppedWindowRef.current === null
      // and snap back) never starts. The user reattaches via the button.
      poppedWindowRef.current = null;
      setPopMode('electron');
      return;
    }
    const open = popOut ?? ((u, n, f) => window.open(u, n, f));
    const features = 'width=1280,height=800,resizable=yes,scrollbars=yes';
    const name = `agent-hub-preview-${sessionId || 'session'}`;
    const win = open(browserPreviewUrl, name, features);
    if (win) {
      poppedWindowRef.current = win;
      setPopMode('browser');
    }
  }, [state.status, browserPreviewUrl, sessionId, popOut, electronApi, onPopOut]);

  const handleReattach = useCallback(() => {
    const w = poppedWindowRef.current;
    if (w && !w.closed) {
      // Best-effort close — the user can still close it manually if the
      // popup-blocker rules forbid programmatic close.
      try {
        w.close();
      } catch {
        /* ignore */
      }
    }
    poppedWindowRef.current = null;
    setPopMode(null);
  }, []);

  const canStop =
    state.status === 'ready' || state.status === 'starting' || state.status === 'failed';

  const handleStop = useCallback(() => {
    if (typeof onStop === 'function') {
      onStop({
        sessionId,
        previewId: state.previewId || '',
      });
    }
  }, [onStop, sessionId, state]);

  const handleConfigure = useCallback(() => {
    if (typeof onConfigure === 'function') onConfigure(event);
  }, [onConfigure, event]);

  // Status pill mapping.
  const pill =
    state.status === 'ready'
      ? { label: 'Ready', cls: 'bg-emerald-700/60 text-emerald-100' }
      : state.status === 'failed'
        ? { label: 'Failed', cls: 'bg-red-700/60 text-red-100' }
        : state.status === 'unavailable'
          ? { label: 'Disabled', cls: 'bg-amber-700/60 text-amber-100' }
          : state.status === 'starting'
            ? { label: 'Starting', cls: 'bg-sky-700/60 text-sky-100' }
            : { label: 'Idle', cls: 'bg-gray-700/60 text-gray-200' };

  return (
    <aside
      data-testid="session-preview-pane"
      className={`hidden lg:flex flex-col shrink-0 border-l border-gray-800 bg-gray-950 relative ${
        isResizing ? 'select-none' : ''
      }`}
      style={{ width: `${width}px` }}
      aria-label="Session preview"
    >
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize preview pane"
        aria-valuenow={width}
        aria-valuemin={320}
        aria-valuemax={1400}
        title="Drag to resize preview"
        onPointerDown={onResizePointerDown}
        onPointerMove={onResizePointerMove}
        onPointerUp={endResize}
        onPointerCancel={endResize}
        className={`absolute top-0 left-0 z-20 flex h-full w-3 -translate-x-1/2 cursor-col-resize touch-none items-center justify-center transition-colors ${
          isResizing ? 'bg-sky-500/50' : 'bg-gray-800/80 hover:bg-sky-500/35'
        }`}
        data-testid="session-preview-pane-resize-handle"
      >
        <GripVertical
          size={14}
          className={`text-gray-500 ${isResizing ? 'text-sky-200' : 'hover:text-sky-300'}`}
          aria-hidden
        />
      </div>

      {/* Top bar — status pill, URL display, copy/refresh/popout/stop, close */}
      <div className="flex items-center gap-2 px-2 py-2 border-b border-gray-800 bg-gray-900/60">
        <span
          className={`rounded px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${pill.cls}`}
          data-testid="session-preview-pane-status"
        >
          {pill.label}
        </span>
        <input
          type="text"
          readOnly
          value={state.status === 'ready' ? browserPreviewUrl : ''}
          placeholder={state.status === 'ready' ? '' : 'No preview running'}
          className="flex-1 min-w-0 bg-gray-800 border border-gray-700 rounded px-2 py-1 text-xs font-mono text-gray-200 disabled:opacity-50"
          aria-label="Preview URL"
          data-testid="session-preview-pane-url"
        />
        <button
          type="button"
          onClick={handleCopyUrl}
          disabled={state.status !== 'ready'}
          title={copied ? 'Copied' : 'Copy URL'}
          aria-label="Copy preview URL"
          data-testid="session-preview-pane-copy"
          className="text-gray-400 hover:text-gray-100 disabled:opacity-40"
        >
          {copied ? <CheckCircle2 size={14} className="text-emerald-300" /> : <Copy size={14} />}
        </button>
        <button
          type="button"
          onClick={handleRefresh}
          disabled={state.status !== 'ready'}
          title="Refresh iframe"
          aria-label="Refresh preview"
          data-testid="session-preview-pane-refresh"
          className="text-gray-400 hover:text-gray-100 disabled:opacity-40"
        >
          <RefreshCw size={14} />
        </button>
        <button
          type="button"
          onClick={handlePopOut}
          disabled={state.status !== 'ready' || popMode !== null}
          title="Open in detached window"
          aria-label="Pop out preview"
          data-testid="session-preview-pane-popout"
          className="text-gray-400 hover:text-gray-100 disabled:opacity-40"
        >
          <Maximize2 size={14} />
        </button>
        <button
          type="button"
          onClick={handleStop}
          disabled={!canStop || !onStop}
          title="Stop preview"
          aria-label="Stop preview"
          data-testid="session-preview-pane-stop"
          className="text-gray-400 hover:text-red-400 disabled:opacity-40"
        >
          <Square size={14} />
        </button>
        <button
          type="button"
          onClick={onClose}
          title="Close pane"
          aria-label="Close preview pane"
          data-testid="session-preview-pane-close"
          className="text-gray-400 hover:text-gray-100 ml-1"
        >
          <X size={14} />
        </button>
      </div>

      {/* Body — iframe / placeholder / failure / unavailable */}
      <div className="flex-1 min-h-0 relative">
        {state.status === 'ready' && popMode === null && (
          <iframe
            key={`${state.previewId}:${iframeKey}`}
            src={iframeSrc}
            title={`Preview ${state.route || '/'}`}
            sandbox="allow-same-origin allow-scripts allow-forms allow-popups allow-modals"
            className="w-full h-full bg-white"
            data-testid="session-preview-pane-iframe"
            data-iframe-key={iframeKey}
            onFocus={() => touchFn()}
            onBlur={() => touchFn()}
            onMouseMove={() => touchFn()}
          />
        )}
        {state.status === 'ready' && popMode !== null && (
          <div
            className="flex flex-col items-center justify-center h-full p-6 text-center text-gray-300"
            data-testid="session-preview-pane-popped"
          >
            <Maximize2 className="text-sky-400 mb-3" size={28} />
            <p className="text-sm font-medium mb-1">Preview is in a detached window</p>
            <p className="text-xs text-gray-500 mb-4">
              Drag the popup to a second monitor; this pane will reattach automatically when you
              close it.
            </p>
            <button
              type="button"
              onClick={handleReattach}
              data-testid="session-preview-pane-reattach"
              className="flex items-center gap-2 bg-sky-600 hover:bg-sky-500 text-white text-xs px-3 py-1.5 rounded-lg"
            >
              <ArrowLeftCircle size={14} />
              Reattach
            </button>
          </div>
        )}
        {state.status === 'idle' && (
          <div
            className="flex flex-col items-center justify-center h-full p-6 text-center text-gray-400"
            data-testid="session-preview-pane-empty"
          >
            <p className="text-sm font-medium mb-1 text-gray-200">No app loaded here</p>
            <p className="text-xs text-gray-500 max-w-xs">
              The agent can edit files in your worktree without starting the preview server. Click{' '}
              <span className="text-sky-300">Start preview</span> below the chat (first time takes a
              few minutes). After it shows <span className="text-emerald-300">Ready</span>, agent
              changes reload automatically and the refresh button reloads this page.
            </p>
          </div>
        )}
        {state.status === 'starting' && (
          <div
            className="flex flex-col h-full text-sky-200"
            data-testid="session-preview-pane-starting"
          >
            <div className="flex flex-col items-center justify-center p-4 border-b border-gray-800">
              <Loader2 size={20} className="animate-spin mb-1.5" />
              <p className="text-sm">Booting preview…</p>
              {state.agentReason && (
                <p className="mt-1 text-xs italic text-gray-400 text-center">{state.agentReason}</p>
              )}
              {typeof state.port === 'number' && (
                <p className="mt-1 text-[10px] text-gray-500 font-mono">port {state.port}</p>
              )}
            </div>
            {/* Live boot log — streams stdout/stderr from the dev server so
                the user can see *where* the boot is stalling instead of
                waiting for a terminal preview/preview_failed event. */}
            <pre
              ref={bootLogRef}
              data-testid="session-preview-pane-starting-log"
              className="flex-1 min-h-0 overflow-auto bg-black/40 px-3 py-2 font-mono text-[11px] text-gray-300 whitespace-pre-wrap"
            >
              {Array.isArray(state.logTail) && state.logTail.length > 0
                ? state.logTail.join('\n')
                : '(waiting for first log line…)'}
            </pre>
          </div>
        )}
        {state.status === 'failed' && (
          <div
            className="flex flex-col h-full p-4 text-red-100"
            data-testid="session-preview-pane-failed"
          >
            <div className="flex items-center gap-2 mb-2">
              <AlertCircle size={16} className="text-red-400" />
              <span className="text-sm font-medium">Preview failed to boot</span>
            </div>
            <div className="text-xs font-mono text-red-200/80 mb-2 break-words">{state.error}</div>
            {state.logTail.length > 0 && (
              <pre
                ref={bootLogRef}
                className="flex-1 min-h-0 overflow-auto rounded bg-black/40 p-2 font-mono text-[11px] text-red-200/80 whitespace-pre-wrap"
              >
                {state.logTail.join('\n')}
              </pre>
            )}
          </div>
        )}
        {state.status === 'unavailable' && (
          <div
            className="flex flex-col items-center justify-center h-full p-6 text-center text-amber-100"
            data-testid="session-preview-pane-unavailable"
          >
            <p className="text-sm font-medium mb-1">
              {state.reason === 'preview-disabled'
                ? 'Preview is disabled for this project'
                : 'Preview isn\u2019t set up yet'}
            </p>
            <p className="text-xs text-amber-200/70 mb-3">
              Configure the preview runtime in project settings to use this pane.
            </p>
            <button
              type="button"
              onClick={handleConfigure}
              disabled={!onConfigure}
              data-testid="session-preview-pane-configure"
              className="bg-amber-700 hover:bg-amber-600 disabled:opacity-50 text-white text-xs px-3 py-1.5 rounded-lg"
            >
              Configure preview
            </button>
          </div>
        )}
      </div>

      {/* Boot log — collapsible; kept after Ready so long compose builds stay visible. */}
      {state.status === 'ready' && hasBootLog && (
        <div className="border-t border-gray-800 bg-gray-900/40 text-xs shrink-0">
          <button
            type="button"
            onClick={() => setFooterOpen((v) => !v)}
            className="w-full text-left px-3 py-1.5 text-gray-400 hover:text-gray-100"
            data-testid="session-preview-pane-footer-toggle"
            aria-expanded={footerOpen}
          >
            {footerOpen ? '\u25BC' : '\u25B6'} Boot log ({state.logTail.length} lines)
            {typeof state.port === 'number' && state.status === 'ready' && (
              <span className="ml-2 text-gray-500 font-mono">:{state.port}</span>
            )}
          </button>
          {footerOpen && (
            <pre
              ref={bootLogRef}
              data-testid="session-preview-pane-log"
              className="max-h-[min(50vh,28rem)] overflow-auto bg-black/40 px-3 py-2 font-mono text-[10px] text-gray-300 whitespace-pre-wrap"
            >
              {state.logTail.join('\n')}
            </pre>
          )}
        </div>
      )}
    </aside>
  );
}
