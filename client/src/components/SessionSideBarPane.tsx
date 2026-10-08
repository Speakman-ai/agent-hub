import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import {
  GripVertical,
  Loader2,
  MessageCircleQuestion,
  RotateCcw,
  Send,
  Square,
  Trash2,
  X,
} from 'lucide-react';
import { api } from '../utils/api';
import { useResizablePaneWidth } from '../hooks/useResizablePaneWidth';
import { MarkdownContent, markdownComponentsCompact } from './MarkdownRenderer';
import { SIDEBAR_WS_EVENT, isSidebarSubmitKey } from '@shared/utils/sessionSidebar';
import { createUseSidebarChat, type SidebarChatApi } from '@shared/hooks/useSidebarChat';

const useSidebarChat = createUseSidebarChat({
  useCallback,
  useEffect,
  useRef,
  useState,
});

const sidebarApi: SidebarChatApi = {
  getSessionSidebar: (id) => api.getSessionSidebar(id),
  getMessages: (id) => api.getMessages(id),
  openSessionSidebar: (id, content) => api.openSessionSidebar(id, content),
  closeSessionSidebar: (id) => api.closeSessionSidebar(id),
};

/** App.tsx re-dispatches SideBar WS events on `window`. */
function subscribeWindowSidebarEvents(cb: (data: any) => void): () => void {
  const handler = (ev: Event) => cb((ev as CustomEvent).detail);
  window.addEventListener(SIDEBAR_WS_EVENT, handler);
  return () => window.removeEventListener(SIDEBAR_WS_EVENT, handler);
}

interface Props {
  parentSessionId: string;
  agentId: string;
  agentName?: string;
  connected: boolean;
  send: (msg: Record<string, unknown>) => void;
  /** Tell App which session id this SideBar streams on (null when none). */
  onSidebarSessionChange: (parentSessionId: string, sidebarSessionId: string | null) => void;
  onClose: () => void;
}

/**
 * SideBar: ask side questions about the current session without adding to its
 * transcript. Backed by a hidden Consult-mode fork of the session; one per
 * session, and "New" replaces it with a fresh fork of the current state. All
 * state transitions live in the shared `useSidebarChat` hook.
 */
export default function SessionSideBarPane({
  parentSessionId,
  agentId,
  agentName,
  connected,
  send,
  onSidebarSessionChange,
  onClose,
}: Props) {
  const { width, isResizing, handleProps } = useResizablePaneWidth({
    storageKey: 'agenthub:sidebar-pane-width',
    defaultWidth: 400,
    min: 300,
    max: 900,
  });
  const {
    state,
    canAsk,
    ask,
    retryQuestion,
    startFresh,
    discard,
    stop,
    retryLoad,
    draft: input,
    setDraft: setInput,
  } = useSidebarChat({
    parentSessionId,
    agentId,
    enabled: true,
    connected,
    api: sidebarApi,
    send,
    subscribe: subscribeWindowSidebarEvents,
    onSidebarSessionChange,
  });
  const scrollRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [state.messages, state.streamingContent]);

  const submit = useCallback(async () => {
    const content = input.trim();
    if (!content || !connected || !canAsk) return;
    setInput('');
    // A failed send stays in the conversation as undelivered (with Retry);
    // only a refused ask leaves the input as the one copy of the text.
    if ((await ask(content)) === 'rejected') setInput((cur) => cur || content);
  }, [input, connected, canAsk, ask, setInput]);

  const ready = state.phase === 'ready';
  const busyOp = state.pendingOp !== null;
  const hasConversation = state.messages.length > 0 || !!state.sidebarId;
  const inputEnabled = connected && ready;

  // Below lg there is no room for a column, so the SideBar covers the chat.
  return (
    <aside
      className={`fixed inset-0 z-40 flex flex-col bg-gray-950 lg:relative lg:inset-auto lg:z-auto lg:w-[var(--sidebar-pane-w)] lg:shrink-0 lg:border-l lg:border-gray-800 ${
        isResizing ? 'select-none' : ''
      }`}
      style={{ '--sidebar-pane-w': `${width}px` } as CSSProperties}
      data-testid="session-sidebar-pane"
    >
      <div
        {...handleProps}
        aria-label="Resize SideBar"
        title="Drag to resize SideBar"
        className={`absolute top-0 left-0 z-20 hidden lg:flex h-full w-3 -translate-x-1/2 cursor-col-resize touch-none items-center justify-center transition-colors focus:outline-none ${
          isResizing ? 'bg-amber-500/50' : 'bg-gray-800/80 hover:bg-amber-500/35'
        }`}
      >
        <GripVertical size={14} className="text-gray-500" aria-hidden />
      </div>
      <div className="flex items-center justify-between gap-2 border-b border-gray-800 px-3 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <MessageCircleQuestion size={15} className="flex-shrink-0 text-amber-300" />
          <div className="min-w-0">
            <div className="text-xs font-semibold text-gray-200">SideBar</div>
            <div className="truncate text-[11px] text-gray-500">
              Side questions on a fork of this session. Nothing here goes into the main chat.
            </div>
          </div>
        </div>
        <div className="flex flex-shrink-0 items-center gap-1">
          {hasConversation && (
            <>
              <button
                type="button"
                onClick={() => void startFresh()}
                disabled={!ready || busyOp || state.busy}
                className="rounded p-1 text-gray-400 hover:bg-gray-800 hover:text-gray-200 disabled:opacity-40"
                title="New SideBar: fork the session again from its current state"
                data-testid="sidebar-new"
              >
                {state.pendingOp === 'fresh' ? (
                  <Loader2 size={14} className="animate-spin" />
                ) : (
                  <RotateCcw size={14} />
                )}
              </button>
              <button
                type="button"
                onClick={() => void discard()}
                disabled={!ready || busyOp}
                className="rounded p-1 text-gray-400 hover:bg-gray-800 hover:text-red-300 disabled:opacity-40"
                title="Discard this SideBar conversation"
                data-testid="sidebar-discard"
              >
                {state.pendingOp === 'discard' ? (
                  <Loader2 size={14} className="animate-spin" />
                ) : (
                  <Trash2 size={14} />
                )}
              </button>
            </>
          )}
          <button
            type="button"
            onClick={onClose}
            className="rounded p-1 text-gray-400 hover:bg-gray-800 hover:text-gray-200"
            title="Hide SideBar (the conversation is kept)"
            data-testid="sidebar-close"
          >
            <X size={14} />
          </button>
        </div>
      </div>

      <div ref={scrollRef} className="flex-1 space-y-3 overflow-y-auto px-3 py-3 text-sm">
        {state.phase === 'load_error' ? (
          <div className="py-6 text-center text-xs text-red-300" data-testid="sidebar-load-error">
            <p>{state.loadError}</p>
            <button
              type="button"
              onClick={retryLoad}
              className="mt-2 rounded bg-gray-800 px-2 py-1 text-gray-200 hover:bg-gray-700"
              data-testid="sidebar-retry"
            >
              Retry
            </button>
          </div>
        ) : state.phase === 'loading' && state.messages.length === 0 ? (
          <div className="flex justify-center py-6">
            <Loader2 size={16} className="animate-spin text-amber-300" />
          </div>
        ) : state.messages.length === 0 && !state.busy ? (
          <p className="py-6 text-center text-xs text-gray-500">
            Ask {agentName || 'the agent'} anything about this session. It sees the whole
            conversation and the working tree, runs in Consult mode, and does not edit code.
          </p>
        ) : (
          state.messages.map((m) =>
            m.role === 'user' ? (
              <div key={m.id} className="ml-6">
                <div
                  className={`whitespace-pre-wrap rounded-lg bg-gray-800 px-3 py-2 text-gray-100 ${
                    m.pending ? 'opacity-70' : ''
                  } ${m.failed ? 'border border-red-900' : ''}`}
                >
                  {m.content}
                </div>
                {m.failed && (
                  <div
                    className="mt-1 flex items-center justify-end gap-2 text-[11px] text-red-300"
                    data-testid="sidebar-undelivered"
                  >
                    Not delivered
                    <button
                      type="button"
                      onClick={() => void retryQuestion(m.id)}
                      disabled={!connected || !canAsk}
                      className="rounded bg-gray-800 px-1.5 py-0.5 text-gray-200 hover:bg-gray-700 disabled:opacity-40"
                      data-testid="sidebar-retry-question"
                    >
                      Retry
                    </button>
                  </div>
                )}
              </div>
            ) : (
              <div key={m.id} className="text-gray-200" data-testid="sidebar-assistant-message">
                <MarkdownContent content={m.content} components={markdownComponentsCompact} />
              </div>
            ),
          )
        )}
        {state.busy &&
          (state.streamingContent ? (
            <div className="text-gray-200">
              <MarkdownContent
                content={state.streamingContent}
                components={markdownComponentsCompact}
              />
            </div>
          ) : (
            <div className="flex items-center gap-2 text-xs text-gray-500">
              <Loader2 size={12} className="animate-spin" /> Thinking…
            </div>
          ))}
        {state.error && (
          <div
            className="rounded border border-red-900 bg-red-950/40 px-2 py-1 text-xs text-red-300"
            data-testid="sidebar-error"
          >
            {state.error}
          </div>
        )}
      </div>

      <div className="border-t border-gray-800 p-2">
        <div className="flex items-end gap-2">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (isSidebarSubmitKey(e)) {
                e.preventDefault();
                void submit();
              }
            }}
            rows={2}
            placeholder={
              !connected ? 'Reconnecting…' : !ready ? 'Loading…' : 'Ask a side question…'
            }
            disabled={!inputEnabled}
            className="min-h-[2.5rem] flex-1 resize-none rounded-md border border-gray-700 bg-gray-900 px-2 py-1.5 text-sm text-gray-100 placeholder-gray-500 focus:border-amber-500 focus:outline-none"
            data-testid="sidebar-input"
          />
          {state.busy ? (
            <button
              type="button"
              onClick={stop}
              className="rounded-md bg-gray-800 p-2 text-gray-200 hover:bg-gray-700"
              title="Stop"
              data-testid="sidebar-stop"
            >
              <Square size={14} />
            </button>
          ) : (
            <button
              type="button"
              onClick={() => void submit()}
              disabled={!connected || !canAsk || !input.trim()}
              className="rounded-md bg-amber-600 p-2 text-white hover:bg-amber-500 disabled:opacity-40"
              title="Ask"
              data-testid="sidebar-send"
            >
              {state.pendingOp === 'open' ? (
                <Loader2 size={14} className="animate-spin" />
              ) : (
                <Send size={14} />
              )}
            </button>
          )}
        </div>
      </div>
    </aside>
  );
}
