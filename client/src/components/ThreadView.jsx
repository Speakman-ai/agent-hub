import { useState, useEffect, useRef, forwardRef, useImperativeHandle } from 'react';
import { ArrowLeft, Clock, Activity, Cpu, AlertCircle } from 'lucide-react';
import { api } from '../utils/api.js';

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
  const scrollRef = useRef(null);
  const wasAtBottomRef = useRef(true);

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
            const isError = entry.content?.startsWith('ERROR:');
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
              <div key={entry.id}>
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
                  <div className="flex-1 min-w-0">
                    <p
                      className={`text-sm whitespace-pre-wrap break-words ${
                        isError ? 'text-red-400' : 'text-gray-300'
                      }`}
                    >
                      {entry.content}
                    </p>
                    {/* Mobile timestamp */}
                    <span className="text-[10px] text-gray-600 font-mono sm:hidden mt-0.5 block">
                      {formatTimestamp(entry.timestamp)}
                    </span>
                  </div>
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

const ThreadView = forwardRef(ThreadViewInner);
ThreadView.displayName = 'ThreadView';
export default ThreadView;
