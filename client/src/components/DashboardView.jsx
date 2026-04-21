import { useState, useEffect, useCallback } from 'react';
import {
  BarChart3,
  Folder,
  Bot,
  MessageCircle,
  Activity,
  ListChecks,
  GitPullRequest,
  AlertTriangle,
  Plus,
  Pencil,
  Sparkles,
  RefreshCw,
} from 'lucide-react';
import { getApiBase, getAuthHeaders } from '../utils/connection.js';
import { relativeTime } from '../utils/time.js';

/**
 * Org-wide dashboard. Renders the response from
 * `GET /api/orgs/:id/dashboard` as three sections:
 *   - 7 headline counter tiles
 *   - kanban breakdown (byColumn + byPriority bar charts)
 *   - recent activity feed
 *
 * Refetches when `orgId` changes (so the OrgSwitcher just works).
 */
/**
 * @param {(agentId: string, sessionId: string) => void} [onOpenSession] — switch agent + open chat session
 * @param {(projectId: string) => void} [onOpenKanban] — open project board
 * @param {(projectId: string) => void} [onOpenPulls] — open project PR list
 * @param {(url: string) => void} [onOpenExternalUrl] — open GitHub etc. (Electron uses shell)
 */
export default function DashboardView({
  orgId,
  onOpenSession,
  onOpenKanban,
  onOpenPulls,
  onOpenExternalUrl,
}) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    if (!orgId) {
      setData(null);
      setError(null);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${getApiBase()}/orgs/${orgId}/dashboard`, {
        headers: { ...getAuthHeaders() },
      });
      if (!res.ok) {
        let detail = '';
        try {
          const body = await res.json();
          detail = body.error || `HTTP ${res.status}`;
        } catch {
          detail = `HTTP ${res.status}`;
        }
        throw new Error(detail);
      }
      const json = await res.json();
      setData(json);
    } catch (err) {
      setError(err.message || String(err));
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [orgId]);

  useEffect(() => {
    load();
  }, [load]);

  if (!orgId) {
    return (
      <div className="flex-1 flex items-center justify-center text-gray-500">
        Select an organization to see its dashboard.
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto bg-gray-950">
      <div className="max-w-6xl mx-auto p-4 md:p-8">
        <div className="flex items-center justify-between mb-6">
          <div className="flex items-center gap-3">
            <BarChart3 size={28} className="text-blue-400" />
            <div>
              <h1 className="text-2xl font-semibold text-white">Dashboard</h1>
              {data?.orgName && <p className="text-sm text-gray-500">{data.orgName}</p>}
            </div>
          </div>
          <button
            type="button"
            onClick={load}
            disabled={loading}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg bg-gray-800 hover:bg-gray-700 text-gray-300 disabled:opacity-50"
            aria-label="Refresh dashboard"
          >
            <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
            Refresh
          </button>
        </div>

        {error && (
          <div
            role="alert"
            className="mb-6 px-4 py-3 rounded-lg bg-red-900/30 border border-red-800 text-red-300 text-sm"
          >
            Failed to load dashboard: {error}
          </div>
        )}

        {!data && !error && loading && (
          <div className="text-gray-500 text-sm">Loading dashboard…</div>
        )}

        {data && (
          <>
            <HeadlineGrid headline={data.headline} />
            <KanbanBreakdown kanban={data.kanban} />
            <RecentActivity
              items={data.recentActivity}
              onOpenSession={onOpenSession}
              onOpenKanban={onOpenKanban}
              onOpenPulls={onOpenPulls}
              onOpenExternalUrl={onOpenExternalUrl}
            />
          </>
        )}
      </div>
    </div>
  );
}

const HEADLINE_TILES = [
  { key: 'projects', label: 'Projects', Icon: Folder, color: 'text-indigo-400' },
  { key: 'agents', label: 'Agents', Icon: Bot, color: 'text-cyan-400' },
  { key: 'sessions', label: 'Sessions', Icon: MessageCircle, color: 'text-blue-400' },
  { key: 'activeSessions', label: 'Active sessions', Icon: Activity, color: 'text-emerald-400' },
  { key: 'openCards', label: 'Open cards', Icon: ListChecks, color: 'text-amber-400' },
  { key: 'openPRs', label: 'Open PRs', Icon: GitPullRequest, color: 'text-fuchsia-400' },
  { key: 'escalations', label: 'Escalations', Icon: AlertTriangle, color: 'text-rose-400' },
];

function HeadlineGrid({ headline = {} }) {
  return (
    <section
      aria-label="Headline counters"
      className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-7 gap-3 mb-8"
    >
      {HEADLINE_TILES.map(({ key, label, Icon, color }) => (
        <div
          key={key}
          data-testid={`headline-${key}`}
          className="bg-gray-900 border border-gray-800 rounded-xl p-4 flex flex-col gap-1"
        >
          <div className={`flex items-center gap-1.5 ${color}`}>
            <Icon size={14} />
            <span className="text-[10px] uppercase tracking-wider font-medium">{label}</span>
          </div>
          <div className="text-2xl font-semibold text-white tabular-nums">
            {Number(headline[key] ?? 0)}
          </div>
        </div>
      ))}
    </section>
  );
}

const PRIORITY_COLORS = {
  urgent: 'bg-rose-500',
  high: 'bg-orange-400',
  medium: 'bg-amber-400',
  low: 'bg-emerald-400',
};

function KanbanBreakdown({ kanban }) {
  if (!kanban) return null;
  const { totalBoards = 0, totalCards = 0, byColumn = [], byPriority = {} } = kanban;
  const columnMax = Math.max(1, ...byColumn.map((b) => b.count || 0));
  const priorityMax = Math.max(
    1,
    ...['urgent', 'high', 'medium', 'low'].map((k) => byPriority[k] || 0),
  );

  return (
    <section aria-label="Kanban breakdown" className="mb-8">
      <div className="flex items-baseline justify-between mb-3">
        <h2 className="text-sm font-semibold text-gray-300 uppercase tracking-wider">Kanban</h2>
        <div className="text-xs text-gray-500">
          {totalCards} card{totalCards === 1 ? '' : 's'} across {totalBoards} board
          {totalBoards === 1 ? '' : 's'}
        </div>
      </div>

      <div className="grid md:grid-cols-2 gap-4">
        <div
          data-testid="kanban-by-column"
          className="bg-gray-900 border border-gray-800 rounded-xl p-4"
        >
          <div className="text-xs text-gray-400 mb-3 font-medium">By column</div>
          {byColumn.length === 0 ? (
            <div className="text-xs text-gray-600">No columns yet.</div>
          ) : (
            <ul className="space-y-2">
              {byColumn.map((row, i) => (
                <li key={`${row.columnName}-${i}`} className="flex items-center gap-3 text-xs">
                  <span className="w-32 truncate text-gray-300">{row.columnName}</span>
                  <div className="flex-1 h-2 bg-gray-800 rounded-full overflow-hidden">
                    <div
                      className="h-full bg-blue-500"
                      style={{
                        width: `${Math.max(2, ((row.count || 0) / columnMax) * 100)}%`,
                      }}
                    />
                  </div>
                  <span className="w-8 text-right text-gray-400 tabular-nums">{row.count}</span>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div
          data-testid="kanban-by-priority"
          className="bg-gray-900 border border-gray-800 rounded-xl p-4"
        >
          <div className="text-xs text-gray-400 mb-3 font-medium">By priority (open)</div>
          <ul className="space-y-2">
            {['urgent', 'high', 'medium', 'low'].map((p) => (
              <li key={p} className="flex items-center gap-3 text-xs">
                <span className="w-32 truncate text-gray-300 capitalize">{p}</span>
                <div className="flex-1 h-2 bg-gray-800 rounded-full overflow-hidden">
                  <div
                    className={`h-full ${PRIORITY_COLORS[p]}`}
                    style={{
                      width: `${Math.max(2, ((byPriority[p] || 0) / priorityMax) * 100)}%`,
                    }}
                  />
                </div>
                <span className="w-8 text-right text-gray-400 tabular-nums">
                  {byPriority[p] || 0}
                </span>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </section>
  );
}

const ACTIVITY_ICONS = {
  card_created: { Icon: Plus, color: 'text-emerald-400', label: 'Card created' },
  card_updated: { Icon: Pencil, color: 'text-amber-400', label: 'Card updated' },
  session_created: { Icon: Sparkles, color: 'text-blue-400', label: 'Session started' },
  escalation: { Icon: AlertTriangle, color: 'text-rose-400', label: 'Escalation' },
  pr_created: { Icon: GitPullRequest, color: 'text-violet-400', label: 'PR opened' },
};

function RecentActivity({
  items = [],
  onOpenSession,
  onOpenKanban,
  onOpenPulls,
  onOpenExternalUrl,
}) {
  const handleRowActivate = (item) => {
    const meta = item.meta || {};
    if (item.type === 'session_created' && meta.agentId && onOpenSession) {
      onOpenSession(String(meta.agentId), item.id);
      return;
    }
    if (item.type === 'card_created' || item.type === 'card_updated') {
      const prUrl = meta.prUrl != null ? String(meta.prUrl) : '';
      if (prUrl && onOpenExternalUrl) {
        onOpenExternalUrl(prUrl);
        return;
      }
      if (meta.projectId && onOpenPulls) {
        onOpenPulls(String(meta.projectId));
        return;
      }
      if (meta.projectId && onOpenKanban) {
        onOpenKanban(String(meta.projectId));
        return;
      }
    }
    if (item.type === 'escalation' && meta.projectId && onOpenKanban) {
      onOpenKanban(String(meta.projectId));
      return;
    }
    if (meta.projectId && onOpenPulls) {
      onOpenPulls(String(meta.projectId));
    }
  };

  const rowIsActionable = (item) => {
    const meta = item.meta || {};
    if (item.type === 'session_created') return Boolean(meta.agentId && onOpenSession);
    if (item.type === 'card_created' || item.type === 'card_updated') {
      return Boolean(
        (meta.projectId && onOpenKanban) ||
        (meta.prUrl && onOpenExternalUrl) ||
        (meta.projectId && onOpenPulls),
      );
    }
    if (item.type === 'escalation') return Boolean(meta.projectId && onOpenKanban);
    return false;
  };

  return (
    <section aria-label="Recent activity">
      <h2 className="text-sm font-semibold text-gray-300 uppercase tracking-wider mb-3">
        Recent activity
      </h2>
      <div
        data-testid="recent-activity"
        className="bg-gray-900 border border-gray-800 rounded-xl divide-y divide-gray-800"
      >
        {items.length === 0 ? (
          <div className="px-4 py-6 text-center text-xs text-gray-600">No recent activity yet.</div>
        ) : (
          items.map((item) => {
            const iconMeta = ACTIVITY_ICONS[item.type] || ACTIVITY_ICONS.session_created;
            const { Icon, color, label } = iconMeta;
            const actionable = rowIsActionable(item);
            const rowClass = actionable
              ? 'w-full text-left px-4 py-3 flex items-center gap-3 transition-colors hover:bg-gray-800/50 cursor-pointer group'
              : 'px-4 py-3 flex items-center gap-3';
            const inner = (
              <>
                <Icon
                  size={16}
                  className={`${color} flex-shrink-0 ${actionable ? 'group-hover:opacity-90' : ''}`}
                />
                <div className="flex-1 min-w-0">
                  <div className="text-sm text-white truncate">{item.title || '(untitled)'}</div>
                  <div className="text-[11px] text-gray-500">{label}</div>
                </div>
                <div className="text-[11px] text-gray-500 flex-shrink-0">
                  {relativeTime(item.timestamp)}
                </div>
              </>
            );
            if (actionable) {
              return (
                <button
                  key={`${item.type}-${item.id}`}
                  type="button"
                  className={rowClass}
                  onClick={() => handleRowActivate(item)}
                >
                  {inner}
                </button>
              );
            }
            return (
              <div key={`${item.type}-${item.id}`} className={rowClass}>
                {inner}
              </div>
            );
          })
        )}
      </div>
    </section>
  );
}
