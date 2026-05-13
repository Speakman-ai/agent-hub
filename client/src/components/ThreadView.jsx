import { useState, useEffect, useRef, forwardRef, useImperativeHandle } from 'react';
import { ArrowLeft, Clock, Activity, Cpu, AlertCircle, Send, User } from 'lucide-react';
import { api } from '../utils/api.js';
import { MarkdownContent } from './MarkdownRenderer.jsx';

/**
 * Classify an entry for rendering. Daemon-written rows ('system') render
 * as the historical log line — monospace timestamp column + markdown
 * content. Human-written rows ('user', via the chatroom composer) render
 * as a right-aligned chat bubble so the human voice is visually distinct
 * from the streaming daemon output, even when the two interleave.
 */
export function classifyEntry(entry) {
  const role = entry?.role || 'system';
  const isError = typeof entry?.content === 'string' && entry.content.startsWith('ERROR:');
  return { role, isError, isHuman: role === 'user' };
}

function formatTimestamp(ts) {
  if (!ts) return '';
  const d = ts.includes('T') ? new Date(ts) : new Date(ts + 'Z');
  const now = new Date();
  const diffMs = now - d;
  const diffMins = Math.floor(diffMs / 60000);
  const diffHrs = Math.floor(diffMs / 3600000);

  let relative;
  if (diffMins < 1) relative = 'just now';
  else if (diffMins < 60) relative = `${diffMins}m ago`;
  else if (diffHrs < 24) relative = `${diffHrs}h ago`;
  else relative = d.toLocaleDateString();

  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  return `${time} · ${relative}`;
}

function ThreadViewInner({ threadId, thread: threadProp, onBack }, ref) {
  const [thread, setThread] = useState(threadProp || null);
  const [entries, setEntries] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState(null);
  const scrollRef = useRef(null);
  const wasAtBottomRef = useRef(true);
  const composerRef = useRef(null);

  // Fetch thread details and entries
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    const load = async () => {
      try {
        const [threadData, entriesData] = await Promise.all([
          threadProp ? Promise.resolve(threadProp) : api.getThread(threadId),
          api.getThreadEntries(threadId),
        ]);
        if (cancelled) return;
        setThread(threadData);
        setEntries(entriesData);
      } catch (err) {
        if (!cancelled) setError(err.message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    load();
    return () => {
      cancelled = true;
    };
  }, [threadId, threadProp]);

  // Track scroll position for auto-scroll
  const handleScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    wasAtBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  };

  // Auto-scroll to bottom when new entries arrive (if already at bottom)
  useEffect(() => {
    const el = scrollRef.current;
    if (el && wasAtBottomRef.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [entries]);

  // Accept new entries via WebSocket (called from App.jsx)
  // This is exposed via the entries state — App.jsx will call addEntry
  const addEntry = (entry) => {
    setEntries((prev) => {
      if (prev.some((e) => e.id === entry.id)) return prev;
      return [...prev, entry];
    });
  };

  useImperativeHandle(ref, () => ({ addEntry }), []);

  // Composer submit — posts a `role='user'` entry into the thread. We
  // optimistically clear the draft on success; the WebSocket broadcast
  // (`thread_entry_created`) reaches us via App.jsx → addEntry, so we
  // don't need to manually splice the entry into state.
  const handleSend = async () => {
    const content = draft.trim();
    if (!content || sending) return;
    setSending(true);
    setSendError(null);
    try {
      await api.postThreadEntry(threadId, content);
      setDraft('');
      // Force auto-scroll on the next entry render even if the user
      // had scrolled up — sending a message implies "show me my message".
      wasAtBottomRef.current = true;
    } catch (err) {
      setSendError(err?.message || 'Failed to send');
    } finally {
      setSending(false);
      // Keep focus on the composer so a user can keep typing.
      composerRef.current?.focus?.();
    }
  };

  const handleComposerKeyDown = (e) => {
    // Enter to send, Shift+Enter for newline (chat convention).
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const typeIcon =
    thread?.type === 'heartbeat' ? (
      <Activity size={14} className="text-rose-400" />
    ) : thread?.type === 'cron' ? (
      <Cpu size={14} className="text-blue-400" />
    ) : (
      <Clock size={14} className="text-gray-400" />
    );

  const typeBadgeColor =
    thread?.type === 'heartbeat'
      ? 'bg-rose-500/20 text-rose-400'
      : thread?.type === 'cron'
        ? 'bg-blue-500/20 text-blue-400'
        : 'bg-gray-500/20 text-gray-400';

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center text-gray-500">
        <div className="animate-spin w-5 h-5 border-2 border-gray-600 border-t-gray-300 rounded-full" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex-1 flex items-center justify-center text-gray-500">
        <div className="text-center">
          <AlertCircle size={32} className="mx-auto mb-2 text-red-400" />
          <p className="text-sm text-red-400">{error}</p>
          {onBack && (
            <button
              onClick={onBack}
              className="mt-3 text-xs text-gray-400 hover:text-gray-200 transition-colors"
            >
              Go back
            </button>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col min-h-0">
      {/* Header */}
      <div className="flex items-center gap-3 px-4 py-3 border-b border-gray-800 bg-gray-900/50">
        {onBack && (
          <button
            onClick={onBack}
            className="text-gray-400 hover:text-gray-200 transition-colors p-1 -ml-1 rounded hover:bg-gray-800"
            title="Back to threads"
          >
            <ArrowLeft size={18} />
          </button>
        )}
        <div className="flex items-center gap-2 min-w-0">
          {typeIcon}
          <h2 className="text-sm font-medium text-gray-200 truncate">{thread?.name}</h2>
          <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded ${typeBadgeColor}`}>
            {thread?.type}
          </span>
        </div>
        <span className="text-xs text-gray-600 ml-auto flex-shrink-0">
          {entries.length} {entries.length === 1 ? 'entry' : 'entries'}
        </span>
      </div>

      {/* Entries log */}
      <div ref={scrollRef} onScroll={handleScroll} className="flex-1 overflow-y-auto p-4 space-y-1">
        {entries.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-gray-600 py-20">
            <Clock size={36} className="mb-3 text-gray-700" />
            <p className="text-sm">No entries yet</p>
            <p className="text-xs text-gray-700 mt-1">
              Entries will appear here when the {thread?.type || 'task'} runs
            </p>
          </div>
        ) : (
          entries.map((entry, idx) => {
            const { isError, isHuman } = classifyEntry(entry);
            const prevEntry = idx > 0 ? entries[idx - 1] : null;
            // Add a date separator if the date changed
            const entryDate = new Date(
              entry.timestamp?.includes('T') ? entry.timestamp : entry.timestamp + 'Z',
            );
            const prevDate = prevEntry
              ? new Date(
                  prevEntry.timestamp?.includes('T')
                    ? prevEntry.timestamp
                    : prevEntry.timestamp + 'Z',
                )
              : null;
            const showDateSep = !prevDate || entryDate.toDateString() !== prevDate.toDateString();

            return (
              <div key={entry.id} data-testid={`thread-entry-${entry.role || 'system'}`}>
                {showDateSep && (
                  <div className="flex items-center gap-3 py-3">
                    <div className="flex-1 border-t border-gray-800" />
                    <span className="text-[10px] font-medium text-gray-600 uppercase tracking-wider">
                      {entryDate.toLocaleDateString(undefined, {
                        weekday: 'short',
                        month: 'short',
                        day: 'numeric',
                      })}
                    </span>
                    <div className="flex-1 border-t border-gray-800" />
                  </div>
                )}
                {isHuman ? (
                  /* Human chatroom bubble — right-aligned to read distinctly
                     against the daemon's left-aligned log stream. */
                  <div className="flex justify-end py-1.5 px-3">
                    <div className="max-w-[80%] flex flex-col items-end gap-0.5">
                      <div className="flex items-center gap-1.5 text-[10px] text-emerald-400/70 font-medium">
                        <User size={10} />
                        <span>you</span>
                        <span className="text-gray-600">·</span>
                        <span className="font-mono text-gray-600">
                          {formatTimestamp(entry.timestamp)}
                        </span>
                      </div>
                      <div className="bg-emerald-500/10 border border-emerald-500/20 text-gray-200 text-sm rounded-lg px-3 py-2 whitespace-pre-wrap break-words">
                        {entry.content}
                      </div>
                    </div>
                  </div>
                ) : (
                  /* System / daemon log line — historical layout. */
                  <div
                    className={`group flex gap-3 py-2 px-3 rounded-lg transition-colors hover:bg-gray-800/40 ${
                      isError ? 'bg-red-950/20' : ''
                    }`}
                  >
                    {/* Timestamp column */}
                    <span className="text-[11px] text-gray-600 font-mono flex-shrink-0 pt-0.5 w-36 hidden sm:block">
                      {formatTimestamp(entry.timestamp)}
                    </span>
                    {/* Content */}
                    <div
                      className={`flex-1 min-w-0 text-sm break-words ${
                        isError ? 'text-red-400' : 'markdown-content text-gray-300'
                      }`}
                    >
                      {isError ? (
                        <p className="whitespace-pre-wrap">{entry.content}</p>
                      ) : (
                        <MarkdownContent content={entry.content} />
                      )}
                      {/* Mobile timestamp */}
                      <span className="text-[10px] text-gray-600 font-mono sm:hidden mt-0.5 block">
                        {formatTimestamp(entry.timestamp)}
                      </span>
                    </div>
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>

      {/* Composer — humans can chat into the same thread alongside the
          daemon's streamed output. Empty drafts are blocked client-side
          AND server-side (400 from POST /entries). */}
      <div className="border-t border-gray-800 bg-gray-900/50 px-3 py-2">
        {sendError && (
          <div className="mb-2 flex items-center gap-2 text-xs text-red-400">
            <AlertCircle size={12} />
            <span className="break-words">{sendError}</span>
          </div>
        )}
        <div className="flex items-end gap-2">
          <textarea
            ref={composerRef}
            aria-label="Post a message in this thread"
            placeholder={`Message this ${thread?.type || 'thread'}…`}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={handleComposerKeyDown}
            rows={1}
            disabled={sending}
            className="flex-1 bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-200 placeholder:text-gray-500 resize-none focus:outline-none focus:border-emerald-500/50 disabled:opacity-50"
          />
          <button
            type="button"
            onClick={handleSend}
            disabled={sending || draft.trim().length === 0}
            aria-label="Send message"
            className="flex-shrink-0 flex items-center justify-center w-9 h-9 rounded-lg bg-emerald-500/20 border border-emerald-500/30 text-emerald-300 hover:bg-emerald-500/30 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <Send size={14} />
          </button>
        </div>
      </div>
    </div>
  );
}

const ThreadView = forwardRef(ThreadViewInner);
ThreadView.displayName = 'ThreadView';
export default ThreadView;
