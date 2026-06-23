import { useState, useEffect, forwardRef, useImperativeHandle } from 'react';
import { Clock, Activity, Cpu, AlertCircle, List } from 'lucide-react';
import { api } from '../utils/api';

function relativeTime(ts: any) {
  if (!ts) return '';
  const d = ts.includes('T') ? new Date(ts) : new Date(ts + 'Z');
  const diffMs = Date.now() - d.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHrs = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);
  if (diffMins < 1) return 'just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHrs < 24) return `${diffHrs}h ago`;
  if (diffDays < 30) return `${diffDays}d ago`;
  return d.toLocaleDateString();
}

function ThreadListInner({ projectId, onSelectThread }: any, ref: any) {
  const [threads, setThreads] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<any>(null);
  const [filter, setFilter] = useState('all'); // 'all' | 'cron' | 'heartbeat'

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    api
      .getThreads(projectId, filter === 'all' ? undefined : filter)
      .then((data: any) => {
        if (!cancelled) setThreads(data);
      })
      .catch((err: any) => {
        if (!cancelled) setError(err.message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [projectId, filter]);

  // Accept new thread from WebSocket
  const addThread = (thread: any) => {
    setThreads((prev: any) => {
      if (prev.some((t: any) => t.id === thread.id)) return prev;
      return [thread, ...prev];
    });
  };

  const removeThread = (threadId: any) => {
    setThreads((prev: any) => prev.filter((t: any) => t.id !== threadId));
  };

  useImperativeHandle(ref, () => ({ addThread, removeThread }), []);

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
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col min-h-0">
      {/* Header with filter */}
      <div className="flex items-center gap-3 px-4 py-3 border-b border-gray-800 bg-gray-900/50">
        <List size={16} className="text-gray-400" />
        <h2 className="text-sm font-medium text-gray-200">Threads</h2>
        <div className="flex items-center gap-1 ml-auto">
          {['all', 'heartbeat', 'cron'].map((f: any) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={`text-[11px] px-2 py-1 rounded transition-colors ${
                filter === f
                  ? 'bg-gray-700 text-gray-200'
                  : 'text-gray-500 hover:text-gray-300 hover:bg-gray-800'
              }`}
            >
              {f === 'all' ? 'All' : f === 'heartbeat' ? 'Heartbeat' : 'Cron'}
            </button>
          ))}
        </div>
      </div>

      {/* Thread list */}
      <div className="flex-1 overflow-y-auto">
        {threads.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-gray-600 py-20">
            <Clock size={36} className="mb-3 text-gray-700" />
            <p className="text-sm">No threads yet</p>
            <p className="text-xs text-gray-700 mt-1">
              Threads are created automatically by cron jobs and heartbeats
            </p>
          </div>
        ) : (
          <div className="p-2 space-y-0.5">
            {threads.map((thread: any) => {
              const isHeartbeat = thread.type === 'heartbeat';
              return (
                <button
                  key={thread.id}
                  onClick={() => onSelectThread(thread)}
                  className="w-full text-left px-3 py-3 rounded-lg flex items-center gap-3 transition-colors hover:bg-gray-800/60 group"
                >
                  {isHeartbeat ? (
                    <Activity size={14} className="text-rose-400 flex-shrink-0" />
                  ) : (
                    <Cpu size={14} className="text-blue-400 flex-shrink-0" />
                  )}
                  <div className="flex-1 min-w-0">
                    <div className="text-sm text-gray-300 group-hover:text-gray-100 truncate">
                      {thread.name}
                    </div>
                    <div className="text-[11px] text-gray-600 mt-0.5">
                      {relativeTime(thread.created_at)}
                    </div>
                  </div>
                  <span
                    className={`text-[10px] font-medium px-1.5 py-0.5 rounded flex-shrink-0 ${
                      isHeartbeat ? 'bg-rose-500/20 text-rose-400' : 'bg-blue-500/20 text-blue-400'
                    }`}
                  >
                    {thread.type}
                  </span>
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

const ThreadList = forwardRef(ThreadListInner);
ThreadList.displayName = 'ThreadList';
export default ThreadList;
