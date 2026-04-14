import { useState, memo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Loader2, GitFork, AlertTriangle, Timer } from 'lucide-react';

/**
 * DelegationPanel — shows inline below a lead agent's message when
 * delegation is active or completed. Displays each sub-agent's task,
 * status (thinking/streaming/done/error), and expandable output.
 */
function DelegationPanel({ delegations, onCancel, sessionId, throttled }) {
  const [collapsed, setCollapsed] = useState(false);
  const [expandedAgents, setExpandedAgents] = useState({});

  if (!delegations || delegations.length === 0) return null;

  const allDone = delegations.every(
    (d) => d.status === 'done' || d.status === 'error' || d.status === 'cancelled',
  );
  const hasErrors = delegations.some((d) => d.status === 'error');
  const doneCount = delegations.filter((d) => d.status === 'done').length;

  const toggleAgent = (delegationId) => {
    setExpandedAgents((prev) => ({
      ...prev,
      [delegationId]: !prev[delegationId],
    }));
  };

  const statusIcon = (status) => {
    switch (status) {
      case 'pending':
        return <Loader2 size={14} className="animate-spin text-gray-500" />;
      case 'running':
        return <span className="inline-block w-2 h-2 rounded-full bg-blue-400 animate-pulse" />;
      case 'done':
        return <span className="text-emerald-400">✓</span>;
      case 'error':
        return <span className="text-red-400">✕</span>;
      case 'cancelled':
        return <span className="text-yellow-400">⊘</span>;
      default:
        return null;
    }
  };

  return (
    <div className="mt-2 mb-3 border border-gray-700/50 rounded-xl bg-gray-850 overflow-hidden">
      {/* Header */}
      <button
        onClick={() => setCollapsed(!collapsed)}
        className="w-full flex items-center justify-between px-4 py-2.5 bg-gray-800/50 hover:bg-gray-800/80 transition-colors"
      >
        <div className="flex items-center gap-2 text-sm">
          <GitFork size={16} />
          <span className="font-medium text-gray-300">Delegation</span>
          <span className="text-xs text-gray-500">
            {allDone
              ? `${doneCount}/${delegations.length} complete${hasErrors ? ' (with errors)' : ''}`
              : `${doneCount}/${delegations.length} running...`}
          </span>
          {throttled && !allDone && (
            <span
              className="flex items-center gap-1 text-xs text-amber-400"
              title="API rate limited — retrying automatically"
            >
              <Timer size={12} />
              <span>throttled</span>
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {!allDone && onCancel && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                onCancel(sessionId);
              }}
              className="text-xs text-gray-500 hover:text-red-400 px-2 py-1 rounded transition-colors"
            >
              Cancel
            </button>
          )}
          <span className="text-gray-600 text-base">{collapsed ? '▸' : '▾'}</span>
        </div>
      </button>

      {/* Sub-agent tasks */}
      {!collapsed && (
        <div className="divide-y divide-gray-700/30">
          {delegations.map((d) => (
            <div key={d.delegationId} className="px-4 py-2.5">
              {/* Agent row */}
              <button
                onClick={() => toggleAgent(d.delegationId)}
                className="w-full flex items-center gap-2 text-left"
              >
                <span
                  className="w-2 h-2 rounded-full flex-shrink-0"
                  style={{ backgroundColor: d.agentColor || '#6b7280' }}
                />
                <span className="text-sm font-medium text-gray-300 flex-1 truncate">
                  {d.agentName}
                </span>
                {statusIcon(d.status)}
                <span className="text-gray-600 text-base ml-1">
                  {expandedAgents[d.delegationId] ? '▾' : '▸'}
                </span>
              </button>

              {/* Task description */}
              <p className="text-xs text-gray-500 mt-1 ml-4 line-clamp-2">{d.task}</p>

              {/* Expanded output */}
              {expandedAgents[d.delegationId] && (
                <div className="mt-2 ml-4">
                  {d.status === 'running' && d.content && (
                    <div className="bg-gray-900/50 rounded-lg p-3 text-sm text-gray-300 max-h-64 overflow-y-auto markdown-content">
                      <ReactMarkdown remarkPlugins={[remarkGfm]}>{d.content}</ReactMarkdown>
                    </div>
                  )}
                  {d.status === 'done' && d.output && (
                    <div className="bg-gray-900/50 rounded-lg p-3 text-sm text-gray-300 max-h-64 overflow-y-auto markdown-content">
                      <ReactMarkdown remarkPlugins={[remarkGfm]}>{d.output}</ReactMarkdown>
                    </div>
                  )}
                  {d.status === 'error' && d.error && (
                    <div className="bg-red-900/20 border border-red-800/30 rounded-lg p-3 text-sm text-red-300">
                      <span className="flex items-center gap-1">
                        <AlertTriangle size={14} /> {d.error}
                      </span>
                    </div>
                  )}
                  {d.status === 'pending' && (
                    <div className="text-xs text-gray-600 italic">Waiting to start...</div>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default memo(DelegationPanel);
