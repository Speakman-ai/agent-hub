import { useState, useEffect, useLayoutEffect, useRef, useCallback } from 'react';
import { Palette, ArrowLeft, RefreshCw, Download, ArrowLeftRight } from 'lucide-react';
import ForwardDesignModal from './ForwardDesignModal.jsx';
import { relativeTime } from '../utils/time.js';
import { getServerBase } from '../utils/connection.js';
import { exportDesignPdf } from '../utils/exportDesignPdf.js';
import { api } from '../utils/api.js';

/**
 * DesignView — split-pane Claude Design workspace:
 *   - Left: single-agent chat with the Design Studio agent
 *   - Right: sandboxed iframe rendering the design's index.html
 *
 * The iframe reloads (via `reloadToken` cache-buster) each time the server
 * emits a `design_updated` WS event for the active design id, so the agent's
 * file writes show up immediately on the canvas.
 */
const DESIGN_STUDIO_ENGINES = ['claude-code', 'cursor-agent', 'gemini-cli', 'codex-cli'];

const DESIGN_ENGINE_LABELS = {
  'claude-code': 'Claude',
  'cursor-agent': 'Cursor',
  'gemini-cli': 'Gemini',
  'codex-cli': 'Codex',
};

/**
 * Engine + model for Design Studio (mirrors session engine/model allowlists from GET /api/config/models).
 */
function DesignStudioEngineModelSelect({
  design,
  modelConfig,
  disabled,
  showToast,
  onDesignRecordUpdated,
}) {
  if (!modelConfig?.engineValidModels) return null;

  const engineOptions = DESIGN_STUDIO_ENGINES.filter(
    (id) => (modelConfig.engineValidModels[id]?.length ?? 0) > 0,
  );
  if (engineOptions.length === 0) return null;

  const storedEngine =
    typeof design?.agent_engine === 'string' && design.agent_engine.trim()
      ? design.agent_engine.trim()
      : 'claude-code';
  const engineValue = engineOptions.includes(storedEngine) ? storedEngine : engineOptions[0];

  const allowed = modelConfig.engineValidModels[engineValue] || [];
  const hubDefault =
    modelConfig.engineDefaultModels?.[engineValue] || modelConfig.defaultModel || '';

  const configured = typeof design?.agent_model === 'string' ? design.agent_model.trim() : '';
  const modelValue = configured && allowed.includes(configured) ? configured : '__default__';

  const handleEngineChange = async (e) => {
    const v = e.target.value;
    try {
      const updated = await api.updateDesign(design.id, { agentEngine: v, agentModel: null });
      onDesignRecordUpdated?.(updated);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      showToast?.(msg, 'error');
    }
  };

  const handleModelChange = async (e) => {
    const v = e.target.value;
    const payload = v === '__default__' ? { agentModel: null } : { agentModel: v };
    try {
      const updated = await api.updateDesign(design.id, payload);
      onDesignRecordUpdated?.(updated);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      showToast?.(msg, 'error');
    }
  };

  return (
    <div className="flex flex-col sm:flex-row sm:items-center gap-2">
      <label className="flex items-center gap-2 text-xs text-gray-500">
        <span className="hidden sm:inline whitespace-nowrap">Engine</span>
        <select
          value={engineValue}
          onChange={handleEngineChange}
          disabled={disabled}
          data-testid="design-studio-engine"
          className="bg-gray-900 border border-gray-700 text-gray-200 rounded-md px-2 py-1 max-w-[140px] sm:max-w-[180px] truncate text-xs focus:outline-none focus:border-gray-500 disabled:opacity-50"
          title="CLI engine for Design Studio"
        >
          {engineOptions.map((id) => (
            <option key={id} value={id}>
              {DESIGN_ENGINE_LABELS[id] || id}
            </option>
          ))}
        </select>
      </label>
      <label className="flex items-center gap-2 text-xs text-gray-500">
        <span className="hidden sm:inline whitespace-nowrap">Model</span>
        <select
          value={modelValue}
          onChange={handleModelChange}
          disabled={disabled}
          data-testid="design-studio-model"
          className="bg-gray-900 border border-gray-700 text-gray-200 rounded-md px-2 py-1 max-w-[200px] sm:max-w-[240px] truncate text-xs focus:outline-none focus:border-gray-500 disabled:opacity-50"
          title={`Model for ${engineValue}`}
        >
          <option value="__default__">{`Default (${hubDefault})`}</option>
          {allowed.map((id) => (
            <option key={id} value={id}>
              {id}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}

// Persisted key + clamp bounds for the split-pane width.
const SPLIT_STORAGE_KEY = 'designSplitPct';
const SPLIT_MIN_PCT = 15;
const SPLIT_MAX_PCT = 85;
const SPLIT_DEFAULT_PCT = 50;
// Width of the resizer bar (Tailwind `w-1`). Kept in sync with the className
// on the separator element so drag math can compensate for it — otherwise the
// handle drifts by ~half a resizer width relative to the cursor at the clamp
// edges.
const RESIZER_WIDTH_PX = 4;

export function clampSplitPct(pct) {
  const n = Number(pct);
  if (!Number.isFinite(n)) return SPLIT_DEFAULT_PCT;
  return Math.min(SPLIT_MAX_PCT, Math.max(SPLIT_MIN_PCT, n));
}

function readStoredSplitPct() {
  try {
    const raw = globalThis.localStorage?.getItem(SPLIT_STORAGE_KEY);
    if (raw == null) return SPLIT_DEFAULT_PCT;
    return clampSplitPct(parseFloat(raw));
  } catch {
    return SPLIT_DEFAULT_PCT;
  }
}

export default function DesignView({
  design,
  messages = [],
  streaming,
  thinking,
  processing,
  reloadToken = 0,
  onBack,
  send,
  onManualReload,
  showToast,
  onDesignRecordUpdated,
  agents = [],
  onDesignForwarded,
}) {
  const splitContainerRef = useRef(null);
  const [splitPct, setSplitPct] = useState(readStoredSplitPct);
  const [dragging, setDragging] = useState(false);
  // Skip the first persistence write — on mount we'd otherwise write back the
  // value we just read from localStorage, which is redundant.
  const hasMountedRef = useRef(false);

  // Only apply split styles on md+ (768px) — mobile uses natural flex stacking.
  const [isMd, setIsMd] = useState(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
    return window.matchMedia('(min-width: 768px)').matches;
  });
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const mql = window.matchMedia('(min-width: 768px)');
    const handler = (e) => setIsMd(e.matches);
    mql.addEventListener('change', handler);
    return () => mql.removeEventListener('change', handler);
  }, []);

  // Persist on change (skip while dragging to avoid thrashing localStorage,
  // and skip the first mount to avoid rewriting the just-read value).
  useEffect(() => {
    if (!hasMountedRef.current) {
      hasMountedRef.current = true;
      return;
    }
    if (dragging) return;
    try {
      globalThis.localStorage?.setItem(SPLIT_STORAGE_KEY, String(splitPct));
    } catch {
      // ignore — private mode / quota
    }
  }, [splitPct, dragging]);

  const onResizerPointerDown = useCallback((e) => {
    e.preventDefault();
    const container = splitContainerRef.current;
    if (!container) return;

    setDragging(true);

    const handleMove = (ev) => {
      const rect = container.getBoundingClientRect();
      if (rect.width <= 0) return;
      // The resizer itself occupies RESIZER_WIDTH_PX inside the flex row;
      // shift the pointer origin by half its width and divide by the space
      // actually available to the two panels so the handle tracks the cursor
      // without ~4px drift at the clamp edges.
      const usable = Math.max(1, rect.width - RESIZER_WIDTH_PX);
      const offset = ev.clientX - rect.left - RESIZER_WIDTH_PX / 2;
      const pct = (offset / usable) * 100;
      setSplitPct(clampSplitPct(pct));
    };
    const handleUp = () => {
      setDragging(false);
      window.removeEventListener('pointermove', handleMove);
      window.removeEventListener('pointerup', handleUp);
      window.removeEventListener('pointercancel', handleUp);
    };

    window.addEventListener('pointermove', handleMove);
    window.addEventListener('pointerup', handleUp);
    window.addEventListener('pointercancel', handleUp);
  }, []);

  const onResizerDoubleClick = useCallback(() => {
    setSplitPct(SPLIT_DEFAULT_PCT);
  }, []);

  const onResizerKeyDown = useCallback((e) => {
    const step = e.shiftKey ? 5 : 2;
    if (e.key === 'ArrowLeft') {
      e.preventDefault();
      setSplitPct((p) => clampSplitPct(p - step));
    } else if (e.key === 'ArrowRight') {
      e.preventDefault();
      setSplitPct((p) => clampSplitPct(p + step));
    } else if (e.key === 'Home') {
      e.preventDefault();
      setSplitPct(SPLIT_MIN_PCT);
    } else if (e.key === 'End') {
      e.preventDefault();
      setSplitPct(SPLIT_MAX_PCT);
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      setSplitPct(SPLIT_DEFAULT_PCT);
    }
  }, []);

  // PDF export is disabled while the agent is still writing/streaming so the
  // capture reflects a stable snapshot of index.html.
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState(null);
  const [modelConfig, setModelConfig] = useState(null);
  const [showForwardDesign, setShowForwardDesign] = useState(false);
  const base = getServerBase();

  useEffect(() => {
    let cancelled = false;
    api
      .getModelConfig()
      .then((cfg) => {
        if (!cancelled) setModelConfig(cfg);
      })
      .catch(() => {
        if (!cancelled) setModelConfig(null);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const designId = design?.id;
  const designName = design?.name;
  const handleDownloadPdf = useCallback(async () => {
    if (!designId || exporting || processing || streaming) return;
    setExporting(true);
    setExportError(null);
    try {
      await exportDesignPdf({
        designId,
        base,
        filename: designName || `design-${designId}`,
      });
    } catch (err) {
      setExportError(err?.message || 'Failed to export PDF');
    } finally {
      setExporting(false);
    }
  }, [base, designId, designName, exporting, processing, streaming]);

  if (!design) return null;

  return (
    <div className="flex flex-col h-full bg-gray-950">
      {/* Header */}
      <div className="border-b border-gray-800 px-4 py-3 flex items-center justify-between flex-shrink-0">
        <div className="flex items-center gap-3 min-w-0">
          {onBack && (
            <button
              onClick={onBack}
              className="text-gray-500 hover:text-gray-200 transition-colors"
              title="Back to designs"
            >
              <ArrowLeft size={16} />
            </button>
          )}
          <Palette size={18} className="text-purple-400" />
          <div className="min-w-0">
            <h2 className="text-sm font-semibold truncate">{design.name}</h2>
            {design.linkedProjects?.length > 0 && (
              <div className="flex items-center gap-1 mt-0.5">
                <span className="text-xs text-gray-500">Linked:</span>
                {design.linkedProjects.slice(0, 3).map((p) => (
                  <span key={p.id} className="text-xs text-gray-400">
                    {p.name}
                  </span>
                ))}
                {design.linkedProjects.length > 3 && (
                  <span className="text-xs text-gray-600">+{design.linkedProjects.length - 3}</span>
                )}
              </div>
            )}
          </div>
        </div>
        <div className="flex flex-col sm:flex-row sm:items-center gap-2 flex-shrink-0">
          <DesignStudioEngineModelSelect
            design={design}
            modelConfig={modelConfig}
            disabled={processing}
            showToast={showToast}
            onDesignRecordUpdated={onDesignRecordUpdated}
          />
          {exportError && (
            <span className="text-xs text-red-400 hidden sm:inline" title={exportError}>
              {exportError}
            </span>
          )}
          <button
            type="button"
            onClick={() => setShowForwardDesign(true)}
            disabled={processing || !!streaming}
            className="flex items-center gap-1.5 text-xs text-gray-400 hover:text-gray-100 disabled:opacity-40 disabled:cursor-not-allowed border border-gray-700 hover:border-gray-500 rounded-md px-2 py-1 transition-colors"
            title={
              processing || streaming
                ? 'Wait for Design Studio to finish before forwarding'
                : 'Open a chat session on another agent with this design as context'
            }
            aria-label="Forward design to agent"
            data-testid="design-forward-open"
          >
            <ArrowLeftRight size={14} />
            <span className="hidden sm:inline">Forward</span>
          </button>
          <button
            onClick={handleDownloadPdf}
            disabled={exporting || processing || !!streaming}
            className="flex items-center gap-1.5 text-xs text-gray-400 hover:text-gray-100 disabled:opacity-40 disabled:cursor-not-allowed border border-gray-700 hover:border-gray-500 rounded-md px-2 py-1 transition-colors"
            title={
              processing || streaming
                ? 'Wait for the agent to finish before exporting'
                : 'Download this design as a PDF'
            }
            aria-label="Download design as PDF"
          >
            <Download size={14} />
            <span className="hidden sm:inline">{exporting ? 'Exporting…' : 'PDF'}</span>
          </button>
        </div>
      </div>

      {showForwardDesign && (
        <ForwardDesignModal
          design={design}
          agents={agents}
          onClose={() => setShowForwardDesign(false)}
          onForward={(body) => api.forwardDesign(design.id, body)}
          onForwarded={onDesignForwarded}
          onError={(msg) => showToast?.(`Forward failed: ${msg}`, 'error', 6000)}
        />
      )}

      {/* Body — split pane (stacked on mobile, horizontally resizable on md+) */}
      <div
        ref={splitContainerRef}
        className={`flex-1 flex min-h-0 flex-col md:flex-row ${
          dragging ? 'select-none cursor-col-resize' : ''
        }`}
      >
        {/* Left: chat */}
        <div
          className="flex flex-col w-full min-h-0 border-b md:border-b-0 border-gray-800"
          style={isMd ? { flexBasis: `${splitPct}%`, flexGrow: 0, flexShrink: 0 } : undefined}
        >
          <DesignChat
            design={design}
            messages={messages}
            streaming={streaming}
            thinking={thinking}
            processing={processing}
            send={send}
          />
        </div>

        {/* Resizer — hidden on mobile, a thin draggable bar on md+. */}
        <div
          role="separator"
          aria-orientation="vertical"
          aria-valuemin={SPLIT_MIN_PCT}
          aria-valuemax={SPLIT_MAX_PCT}
          aria-valuenow={Math.round(splitPct)}
          aria-label="Resize chat panel"
          tabIndex={0}
          onPointerDown={onResizerPointerDown}
          onDoubleClick={onResizerDoubleClick}
          onKeyDown={onResizerKeyDown}
          data-testid="design-split-resizer"
          className={`hidden md:flex relative items-center justify-center flex-shrink-0 w-1 cursor-col-resize bg-gray-800 hover:bg-blue-500/60 focus:outline-none focus:bg-blue-500/80 transition-colors ${
            dragging ? 'bg-blue-500' : ''
          }`}
          title="Drag to resize — double-click to reset"
        >
          {/* Wider invisible hit area for easier grabbing */}
          <span className="absolute inset-y-0 -left-1.5 -right-1.5" aria-hidden="true" />
        </div>

        {/* Right: canvas iframe */}
        <div
          className="flex flex-col w-full min-h-0"
          style={isMd ? { flexBasis: `${100 - splitPct}%`, flexGrow: 1, flexShrink: 1 } : undefined}
        >
          <DesignCanvas
            designId={design.id}
            reloadToken={reloadToken}
            onManualReload={onManualReload}
          />
        </div>
      </div>
    </div>
  );
}

/**
 * DesignChat — single-agent chat pane adapted from RoomChat. Strips the
 * multi-agent @mention autocomplete and the "manage agents" / max-turns
 * controls — there's only ever one Design Studio agent per design.
 */
function DesignChat({ design, messages, streaming, thinking, processing, send }) {
  const [input, setInput] = useState('');
  const messagesEndRef = useRef(null);
  const scrollContainerRef = useRef(null);
  const initialScrollRef = useRef(true);
  const isNearBottomRef = useRef(true);
  const programmaticScrollRef = useRef(false);
  const scrollRafRef = useRef(null);
  const [showScrollBtn, setShowScrollBtn] = useState(false);
  const inputRef = useRef(null);

  const checkNearBottom = useCallback(() => {
    const el = scrollContainerRef.current;
    if (!el) return true;
    const threshold = 150;
    return el.scrollHeight - el.scrollTop - el.clientHeight < threshold;
  }, []);

  const handleScrollEvent = useCallback(() => {
    if (programmaticScrollRef.current) return;
    const nearBottom = checkNearBottom();
    isNearBottomRef.current = nearBottom;
    setShowScrollBtn(!nearBottom);
  }, [checkNearBottom]);

  const scrollToBottom = useCallback((instant) => {
    if (scrollRafRef.current) cancelAnimationFrame(scrollRafRef.current);
    const el = scrollContainerRef.current;
    if (instant && el) {
      programmaticScrollRef.current = true;
      el.scrollTop = el.scrollHeight;
      requestAnimationFrame(() => {
        programmaticScrollRef.current = false;
        isNearBottomRef.current = true;
        setShowScrollBtn(false);
      });
      return;
    }
    programmaticScrollRef.current = true;
    scrollRafRef.current = requestAnimationFrame(() => {
      messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
      setTimeout(() => {
        programmaticScrollRef.current = false;
        isNearBottomRef.current = true;
        setShowScrollBtn(false);
      }, 200);
    });
  }, []);

  useLayoutEffect(() => {
    if (initialScrollRef.current || isNearBottomRef.current) {
      scrollToBottom(initialScrollRef.current);
    }
    initialScrollRef.current = false;
  }, [messages, streaming, thinking, scrollToBottom]);

  useLayoutEffect(() => {
    initialScrollRef.current = true;
    isNearBottomRef.current = true;
    setShowScrollBtn(false);
  }, [design.id]);

  // Auto-resize textarea (capped at ~200px)
  useEffect(() => {
    if (inputRef.current) {
      inputRef.current.style.height = 'auto';
      inputRef.current.style.height = Math.min(inputRef.current.scrollHeight, 200) + 'px';
    }
  }, [input]);

  const handleSend = (e) => {
    e?.preventDefault?.();
    if (!input.trim()) return;
    send?.({ type: 'design_chat', designId: design.id, content: input.trim() });
    setInput('');
  };

  const handleCancel = () => {
    send?.({ type: 'design_cancel', designId: design.id });
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  return (
    <>
      <div
        ref={scrollContainerRef}
        onScroll={handleScrollEvent}
        className="flex-1 overflow-y-auto p-3 md:p-4 relative"
      >
        <div className="max-w-3xl mx-auto">
          {messages.length === 0 && !thinking && !streaming && (
            <div className="flex flex-col items-center justify-center h-full text-gray-600 py-20">
              <Palette size={40} className="mb-3 text-gray-700" />
              <p className="text-sm">Design Studio is ready</p>
              <p className="text-xs text-gray-700 mt-1">
                Describe what you want and the agent will build it into index.html
              </p>
            </div>
          )}

          {messages.map((msg) => (
            <DesignMessage key={msg.id} message={msg} />
          ))}

          {thinking && (
            <div className="flex items-start gap-3 py-3">
              <span className="w-3 h-3 rounded-full mt-1 flex-shrink-0 bg-purple-400 animate-pulse" />
              <div className="text-sm text-gray-500">Design Studio is thinking…</div>
            </div>
          )}

          {streaming && (
            <div className="flex items-start gap-3 py-3">
              <span className="w-3 h-3 rounded-full mt-1.5 flex-shrink-0 bg-purple-400" />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 mb-1">
                  <span className="text-xs font-semibold text-purple-400">Design Studio</span>
                  <span className="text-xs text-gray-600 animate-pulse">streaming…</span>
                </div>
                <div className="text-sm text-gray-300 whitespace-pre-wrap">
                  {streaming.content}
                  <span className="inline-block w-2 h-4 bg-gray-500 animate-pulse ml-0.5" />
                </div>
              </div>
            </div>
          )}

          <div ref={messagesEndRef} />
        </div>

        {showScrollBtn && (
          <button
            onClick={() => scrollToBottom(false)}
            className="sticky bottom-4 left-1/2 -translate-x-1/2 mx-auto flex items-center gap-1.5 bg-gray-800/90 hover:bg-gray-700 border border-gray-600/50 text-gray-300 text-xs px-3 py-2 rounded-full shadow-lg backdrop-blur-sm transition-all hover:text-white z-10"
            style={{ width: 'fit-content', display: 'flex' }}
          >
            <svg
              className="w-3.5 h-3.5"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2.5}
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="M19 14l-7 7m0 0l-7-7m7 7V3" />
            </svg>
            Scroll to bottom
          </button>
        )}
      </div>

      {/* Input */}
      <div className="border-t border-gray-800 p-3 flex-shrink-0">
        <div className="max-w-3xl mx-auto">
          <form onSubmit={handleSend} className="flex items-end gap-2">
            <textarea
              ref={inputRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={
                processing
                  ? 'Agent is working — queue a follow-up…'
                  : 'Describe what to build or change — Shift+Enter for newline'
              }
              rows={1}
              className="flex-1 bg-gray-900 border border-gray-700 rounded-xl px-4 py-3 text-sm text-gray-100 focus:outline-none focus:border-gray-500 resize-none"
            />
            <div className="flex gap-1">
              {processing && (
                <button
                  type="button"
                  onClick={handleCancel}
                  className="bg-red-600/80 hover:bg-red-600 text-white px-4 py-3 rounded-xl text-sm transition-colors"
                >
                  Cancel
                </button>
              )}
              <button
                type="submit"
                disabled={!input.trim()}
                className="bg-blue-600 hover:bg-blue-500 disabled:opacity-30 disabled:hover:bg-blue-600 text-white px-4 py-3 rounded-xl text-sm transition-colors"
              >
                {processing ? 'Queue' : 'Send'}
              </button>
            </div>
          </form>
        </div>
      </div>
    </>
  );
}

function DesignMessage({ message }) {
  const isUser = message.role === 'user';
  if (isUser) {
    return (
      <div className="flex items-start gap-3 py-3">
        <span className="w-3 h-3 rounded-full mt-1.5 bg-gray-500 flex-shrink-0" />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <span className="text-xs font-semibold text-gray-400">You</span>
            <span className="text-xs text-gray-600">{relativeTime(message.created_at)}</span>
          </div>
          <div className="text-sm text-gray-200 whitespace-pre-wrap">{message.content}</div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex items-start gap-3 py-3">
      <span className="w-3 h-3 rounded-full mt-1.5 flex-shrink-0 bg-purple-400" />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 mb-1">
          <span className="text-xs font-semibold text-purple-400">Design Studio</span>
          <span className="text-xs text-gray-600">{relativeTime(message.created_at)}</span>
        </div>
        <div className="text-sm text-gray-300 whitespace-pre-wrap">{message.content}</div>
      </div>
    </div>
  );
}

/**
 * injectBaseHref — inject (or replace) a `<base href>` tag into an HTML
 * document string so that relative asset paths inside an iframe loaded via
 * `srcdoc` still resolve against the original server URL.
 *
 * `srcdoc` iframes have an opaque origin (about:srcdoc) and are NOT subject
 * to `X-Frame-Options` — that header only gates top-level frame navigation,
 * not inline documents or sub-resources. Injecting `<base>` is what lets
 * relative `<link>`, `<script>`, `<img>` loads still reach the design-files
 * directory on the server.
 */
export function injectBaseHref(html, baseHref) {
  const safeHref = String(baseHref).replace(/"/g, '&quot;');
  const baseTag = `<base href="${safeHref}">`;

  // Replace existing <base ...> if present
  if (/<base\b[^>]*>/i.test(html)) {
    return html.replace(/<base\b[^>]*>/i, baseTag);
  }

  // Insert immediately after the opening <head ...> if present
  if (/<head\b[^>]*>/i.test(html)) {
    return html.replace(/(<head\b[^>]*>)/i, `$1${baseTag}`);
  }

  // Minimal fallback — prepend to the document
  return `${baseTag}${html}`;
}

/**
 * DesignCanvas — sandboxed iframe that loads the design's static artifacts.
 *
 * The deployed nginx config sends `X-Frame-Options: DENY` globally, which
 * blocks `<iframe src="...">` loads of design-files with `ERR_BLOCKED_BY_RESPONSE`.
 * Workaround: fetch the HTML as text and feed it to the iframe via `srcdoc`.
 * `srcdoc` documents have an opaque origin and are not subject to XFO, and
 * sub-resources (CSS/JS/images) are not gated by XFO either — we just need
 * a `<base href>` so relative paths resolve back to the server.
 *
 * `reloadToken` re-runs the fetch (e.g. on every `design_updated` WS event)
 * so the agent's file writes show up immediately on the canvas.
 */
export function DesignCanvas({ designId, reloadToken, onManualReload }) {
  const base = getServerBase();
  const [srcdoc, setSrcdoc] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    setSrcdoc(null);
    setError(null);

    // `/design-files/` is served by express.static BEFORE authMiddleware's
    // gate (which only guards `/api/*` — see server/auth.ts). It is not
    // cookie-authenticated, so we must NOT set `credentials: 'include'`: in
    // remote mode (Vite client → EC2 hub) `cors-config.ts` replies with
    // `credentials: false`, and the browser rejects the response with
    // "Access-Control-Allow-Credentials must be 'true'". Path is gated by
    // the opaque designId + per-design org check inside the handler.
    const url = `${base}/design-files/${designId}/index.html?v=${reloadToken}`;
    fetch(url)
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.text();
      })
      .then((html) => {
        if (cancelled) return;
        const baseHref = `${base}/design-files/${designId}/`;
        setSrcdoc(injectBaseHref(html, baseHref));
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err?.message || 'Failed to load design');
      });

    return () => {
      cancelled = true;
    };
  }, [base, designId, reloadToken]);

  return (
    <>
      <div className="border-b border-gray-800 px-4 py-2 flex items-center justify-between flex-shrink-0">
        <span className="text-xs text-gray-500 font-mono truncate">index.html</span>
        <button
          onClick={onManualReload}
          className="text-gray-500 hover:text-gray-200 transition-colors"
          title="Reload canvas"
        >
          <RefreshCw size={14} />
        </button>
      </div>
      {error ? (
        <div className="flex-1 flex items-center justify-center bg-white">
          <div className="text-xs text-red-600">Failed to load design: {error}</div>
        </div>
      ) : srcdoc === null ? (
        <div className="flex-1 flex items-center justify-center bg-white">
          <div className="text-xs text-gray-500">Loading…</div>
        </div>
      ) : (
        <iframe
          key={reloadToken}
          title={`design-canvas-${designId}`}
          srcDoc={srcdoc}
          sandbox="allow-scripts"
          className="flex-1 w-full bg-white border-0"
        />
      )}
    </>
  );
}
