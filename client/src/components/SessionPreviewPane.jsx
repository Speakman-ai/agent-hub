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
} from 'lucide-react';
import {
  derivePaneState,
  createActivityTouch,
  clampPaneWidth,
  paneWidthStorageKey,
  DEFAULT_PANE_WIDTH,
} from '../utils/sessionPreviewState.js';

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
  // The collapsed footer log-tail is shown on demand; default closed.
  defaultFooterOpen = false,
}) {
  const state = useMemo(() => derivePaneState(event), [event]);
  const [iframeKey, setIframeKey] = useState(0);
  const [copied, setCopied] = useState(false);
  // 'browser' — window.open pop-out, tracked via poppedWindowRef.
  // 'electron' — IPC-owned BrowserWindow, no JS handle; we never get closed
  //              events, so the user reattaches manually or via the button.
  // null       — not popped out.
  const [popMode, setPopMode] = useState(null);
  const [footerOpen, setFooterOpen] = useState(defaultFooterOpen);
  const poppedWindowRef = useRef(null);

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
    if (!widthKey) return;
    try {
      window.localStorage.setItem(widthKey, String(width));
    } catch {
      // Storage failures (private mode, quota) are non-fatal — width
      // just won't survive reload.
    }
  }, [widthKey, width]);

  // Resize drag handle.
  const dragStateRef = useRef(null);
  const onResizeStart = (e) => {
    dragStateRef.current = { startX: e.clientX, startWidth: width };
    e.preventDefault();
  };
  useEffect(() => {
    const onMove = (e) => {
      if (!dragStateRef.current) return;
      const { startX, startWidth } = dragStateRef.current;
      // The pane lives on the right — dragging the handle left expands it.
      const next = clampPaneWidth(startWidth + (startX - e.clientX));
      setWidth(next);
    };
    const onUp = () => {
      dragStateRef.current = null;
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, []);

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
    if (state.status !== 'ready' || !state.url) return;
    try {
      await navigator.clipboard.writeText(state.url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Permission denied — silently ignore; the link is still visible.
    }
  }, [state]);

  const handlePopOut = useCallback(() => {
    if (state.status !== 'ready' || !state.url) return;
    if (typeof onPopOut === 'function') {
      onPopOut({ sessionId, previewId: state.previewId, url: state.url });
    }
    const api = electronApi ?? (typeof window !== 'undefined' ? window.electronAPI : null);
    if (api && typeof api.popOutPreview === 'function') {
      api.popOutPreview({ sessionId, url: state.url });
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
    const win = open(state.url, name, features);
    if (win) {
      poppedWindowRef.current = win;
      setPopMode('browser');
    }
  }, [state, sessionId, popOut, electronApi, onPopOut]);

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

  const handleStop = useCallback(() => {
    if (typeof onStop === 'function') {
      onStop({ sessionId, previewId: state.status === 'ready' ? state.previewId : '' });
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
      className="hidden lg:flex flex-col shrink-0 border-l border-gray-800 bg-gray-950 relative"
      style={{ width: `${width}px` }}
      aria-label="Session preview"
    >
      {/* Resize handle — invisible 6px gutter on the left edge. */}
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize preview pane"
        onMouseDown={onResizeStart}
        className="absolute top-0 left-0 h-full w-1.5 cursor-col-resize hover:bg-sky-500/40"
        data-testid="session-preview-pane-resize-handle"
      />

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
          value={state.status === 'ready' ? state.url : ''}
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
          disabled={state.status !== 'ready' || !onStop}
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
            src={state.url}
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
            <p className="text-sm font-medium mb-1 text-gray-200">No preview yet</p>
            <p className="text-xs text-gray-500">
              Ask the agent to emit{' '}
              <code className="rounded bg-gray-800 px-1 py-0.5 font-mono">
                &lt;agenthub:preview&gt;
              </code>{' '}
              and this pane will boot the running app for you.
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
              <pre className="flex-1 min-h-0 overflow-auto rounded bg-black/40 p-2 font-mono text-[11px] text-red-200/80">
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

      {/* Footer log tail — collapsible. Hidden until the user expands. */}
      {state.status === 'ready' && (
        <div className="border-t border-gray-800 bg-gray-900/40 text-xs">
          <button
            type="button"
            onClick={() => setFooterOpen((v) => !v)}
            className="w-full text-left px-3 py-1.5 text-gray-400 hover:text-gray-100"
            data-testid="session-preview-pane-footer-toggle"
            aria-expanded={footerOpen}
          >
            {footerOpen ? '\u25BC' : '\u25B6'} Log tail
            {typeof state.port === 'number' && (
              <span className="ml-2 text-gray-500 font-mono">:{state.port}</span>
            )}
          </button>
          {footerOpen && (
            <pre
              data-testid="session-preview-pane-log"
              className="max-h-32 overflow-auto bg-black/40 px-3 py-2 font-mono text-[10px] text-gray-300"
            >
              {/* The runtime log tail isn't fed through the broadcast on
                  success — `preview` events carry only screenshotPath /
                  port / url. We surface a placeholder so the user knows
                  the toggle works; the failed-state log tail is shown
                  inline in the body above. */}
              {'(no tail captured for ready previews — see chat for boot logs)'}
            </pre>
          )}
        </div>
      )}
    </aside>
  );
}
