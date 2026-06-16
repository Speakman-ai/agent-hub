import { useState, useEffect, useMemo } from 'react';
import {
  LifeBuoy,
  AlertCircle,
  Bug,
  Lightbulb,
  HelpCircle,
  Flame,
  MessageSquare,
  Sparkles,
  Folder,
} from 'lucide-react';
import { api } from '../utils/api.js';

function relativeTime(ts) {
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

// Severity → sort rank (most urgent first). Mirrors the server's ORDER BY so a
// client-side re-sort (after project filtering) keeps the same order.
const SEVERITY_RANK = { critical: 0, high: 1, medium: 2, low: 3 };

const SEVERITY_BADGE = {
  critical: 'bg-red-500/20 text-red-300 border-red-500/40',
  high: 'bg-orange-500/20 text-orange-300 border-orange-500/40',
  medium: 'bg-amber-500/20 text-amber-300 border-amber-500/40',
  low: 'bg-gray-600/30 text-gray-300 border-gray-600/50',
};

const TYPE_META = {
  bug: { label: 'Bug', Icon: Bug, className: 'text-rose-400' },
  feature_request: { label: 'Feature request', Icon: Lightbulb, className: 'text-emerald-400' },
  question: { label: 'Question', Icon: HelpCircle, className: 'text-sky-400' },
  incident: { label: 'Incident', Icon: Flame, className: 'text-red-400' },
  other: { label: 'Other', Icon: MessageSquare, className: 'text-gray-400' },
};

const STATUS_FILTERS = [
  { key: 'all', label: 'All' },
  { key: 'new', label: 'New' },
  { key: 'investigating', label: 'Investigating' },
  { key: 'converted', label: 'Converted' },
  { key: 'closed', label: 'Closed' },
];

// Severity-first, newest-within-severity. Exported for unit testing.
function sortBySeverity(list) {
  return [...list].sort((a, b) => {
    const sa = SEVERITY_RANK[a.severity] ?? 4;
    const sb = SEVERITY_RANK[b.severity] ?? 4;
    if (sa !== sb) return sa - sb;
    return (b.created_at || '').localeCompare(a.created_at || '');
  });
}

function SupportIssueRow({ ticket, onOpenProject }) {
  const type = TYPE_META[ticket.type] || TYPE_META.other;
  const { Icon } = type;
  const severityClass = SEVERITY_BADGE[ticket.severity] || SEVERITY_BADGE.low;
  const title = ticket.subject?.trim() || ticket.body?.trim() || '(no subject)';

  return (
    <div
      data-testid="support-issue-row"
      data-severity={ticket.severity}
      data-project-id={ticket.project_id}
      className="relative bg-gray-900 border border-gray-800 rounded-lg p-4 hover:border-gray-700 transition-colors"
    >
      <div className="flex items-start gap-3">
        <Icon size={16} className={`flex-shrink-0 mt-0.5 ${type.className}`} />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span
              className={`text-[10px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded border ${severityClass}`}
            >
              {ticket.severity}
            </span>
            <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-gray-800 text-gray-300">
              {type.label}
            </span>
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-gray-800/60 text-gray-500">
              {ticket.status}
            </span>
            <button
              type="button"
              onClick={() => onOpenProject?.(ticket.project_id)}
              title={`Open ${ticket.project_name}'s support queue`}
              data-testid="issue-project-link"
              className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded bg-blue-500/10 text-blue-300 border border-blue-500/20 hover:bg-blue-500/20 transition-colors"
            >
              <Folder size={10} />
              {ticket.project_name}
            </button>
            <span className="text-[11px] text-gray-600 ml-auto">
              {relativeTime(ticket.created_at)}
            </span>
          </div>

          <div className="text-sm mt-1.5 break-words text-gray-200 font-medium">{title}</div>

          {ticket.reporter ? (
            <div className="text-[11px] text-gray-600 mt-1.5">Reported by {ticket.reporter}</div>
          ) : null}

          {ticket.ai_summary ? (
            <div className="mt-2 flex items-start gap-2 rounded-md bg-violet-500/10 border border-violet-500/20 px-2.5 py-2">
              <Sparkles size={13} className="text-violet-300 flex-shrink-0 mt-0.5" />
              <div className="text-xs text-gray-300 whitespace-pre-wrap break-words">
                {ticket.ai_summary}
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

// Cross-project support overview: compiles every project's support issues into
// one severity-ordered list, with a project filter (default "All projects").
export default function SupportIssuesOverview({ onOpenProjectSupport }) {
  const [tickets, setTickets] = useState([]);
  const [projects, setProjects] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [statusFilter, setStatusFilter] = useState('all');
  const [projectFilter, setProjectFilter] = useState('all');

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    api
      .getAllSupportTickets(statusFilter === 'all' ? undefined : statusFilter)
      .then((data) => {
        if (cancelled) return;
        setTickets(Array.isArray(data?.tickets) ? data.tickets : []);
        setProjects(Array.isArray(data?.projects) ? data.projects : []);
      })
      .catch((err) => {
        if (!cancelled) setError(err.message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [statusFilter]);

  // Client-side project filtering keeps the project dropdown options stable (a
  // server round-trip would only return the filtered project's rows). Re-sort
  // so the severity order survives the filter.
  const visible = useMemo(() => {
    const scoped =
      projectFilter === 'all' ? tickets : tickets.filter((t) => t.project_id === projectFilter);
    return sortBySeverity(scoped);
  }, [tickets, projectFilter]);

  return (
    <div className="flex-1 flex flex-col min-h-0">
      {/* Header with project + status filters */}
      <div className="flex items-center gap-3 px-4 py-3 border-b border-gray-800 bg-gray-900/50 flex-wrap">
        <LifeBuoy size={16} className="text-blue-400" />
        <h2 className="text-sm font-medium text-gray-200">Support Issues</h2>

        <label className="ml-2 inline-flex items-center gap-1.5 text-[11px] text-gray-500">
          <Folder size={12} />
          <select
            data-testid="project-filter"
            value={projectFilter}
            onChange={(e) => setProjectFilter(e.target.value)}
            className="bg-gray-800 text-gray-200 text-[11px] rounded border border-gray-700 px-1.5 py-1 focus:outline-none focus:border-gray-600"
          >
            <option value="all">All projects</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name} ({p.count})
              </option>
            ))}
          </select>
        </label>

        <div className="flex items-center gap-1 ml-auto flex-wrap justify-end">
          {STATUS_FILTERS.map((f) => (
            <button
              key={f.key}
              onClick={() => setStatusFilter(f.key)}
              className={`text-[11px] px-2 py-1 rounded transition-colors ${
                statusFilter === f.key
                  ? 'bg-gray-700 text-gray-200'
                  : 'text-gray-500 hover:text-gray-300 hover:bg-gray-800'
              }`}
            >
              {f.label}
            </button>
          ))}
        </div>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto">
        {loading ? (
          <div className="flex items-center justify-center h-full text-gray-500">
            <div className="animate-spin w-5 h-5 border-2 border-gray-600 border-t-gray-300 rounded-full" />
          </div>
        ) : error ? (
          <div className="flex items-center justify-center h-full text-gray-500">
            <div className="text-center">
              <AlertCircle size={32} className="mx-auto mb-2 text-red-400" />
              <p className="text-sm text-red-400">{error}</p>
            </div>
          </div>
        ) : visible.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-gray-600 py-20">
            <LifeBuoy size={36} className="mb-3 text-gray-700" />
            <p className="text-sm">No support issues</p>
            <p className="text-xs text-gray-700 mt-1">
              Issues from every project appear here, most urgent first.
            </p>
          </div>
        ) : (
          <div className="p-3 space-y-2 max-w-3xl mx-auto">
            {visible.map((ticket) => (
              <SupportIssueRow
                key={ticket.id}
                ticket={ticket}
                onOpenProject={onOpenProjectSupport}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export { sortBySeverity };
