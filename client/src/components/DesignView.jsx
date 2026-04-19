import { useState, useEffect, useLayoutEffect, useRef, useCallback } from 'react';
import { Palette, ArrowLeft, RefreshCw } from 'lucide-react';
import { relativeTime } from '../utils/time.js';
import { getServerBase } from '../utils/connection.js';

/**
 * DesignView — split-pane Claude Design workspace:
 *   - Left: single-agent chat with the Design Studio agent
 *   - Right: sandboxed iframe rendering the design's index.html
 *
 * The iframe reloads (via `reloadToken` cache-buster) each time the server
 * emits a `design_updated` WS event for the active design id, so the agent's
 * file writes show up immediately on the canvas.
 */
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
}) {
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
      </div>

      {/* Body — split pane */}
      <div className="flex-1 flex min-h-0 flex-col md:flex-row">
        {/* Left: chat */}
        <div className="flex flex-col w-full md:w-1/2 min-h-0 border-b md:border-b-0 md:border-r border-gray-800">
          <DesignChat
            design={design}
            messages={messages}
            streaming={streaming}
            thinking={thinking}
            processing={processing}
            send={send}
          />
        </div>

        {/* Right: canvas iframe */}
        <div className="flex flex-col w-full md:w-1/2 min-h-0">
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
 * DesignCanvas — sandboxed iframe that loads the design's static artifacts.
 * `reloadToken` is the cache-busting query param; incrementing it (e.g. on
 * every `design_updated` WS event) forces the iframe to re-fetch index.html.
 */
function DesignCanvas({ designId, reloadToken, onManualReload }) {
  const base = getServerBase();
  const src = `${base}/design-files/${designId}/index.html?v=${reloadToken}`;

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
      <iframe
        key={reloadToken}
        title={`design-canvas-${designId}`}
        src={src}
        sandbox="allow-scripts"
        className="flex-1 w-full bg-white border-0"
      />
    </>
  );
}
