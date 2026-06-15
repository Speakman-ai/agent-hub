import { useState, useEffect, useCallback } from 'react';
import {
  BarChart3,
  GitPullRequest,
  AlertTriangle,
  Plus,
  Pencil,
  Sparkles,
  RefreshCw,
  UserCircle,
} from 'lucide-react';
import { getApiBase, getAuthHeaders } from '../utils/connection.js';
import { getAuthRecord } from '../utils/auth.js';
import { relativeTime } from '../utils/time.js';
import { parseNativePrUrl } from '../utils/prFormatting.js';
import SessionStateIcon from './SessionStateIcon.jsx';
import { sessionStateMeta } from '../../../shared/utils/sessionState.js';

/**
 * Org-wide dashboard. Renders the response from
 * `GET /api/orgs/:id/dashboard`, top to bottom:
 *   - active sessions (every in-flight session that has not merged yet)
 *   - open PRs (cards with an unmerged PR link)
 *   - kanban breakdown (byColumn + byPriority bar charts)
 *   - recent activity feed
 *
 * Refetches when `orgId` changes (so the OrgSwitcher just works).
 */
/**
 * @param {(view: string) => void} [onNavigate] — navigate to a top-level view (e.g. 'settings:account')
 * @param {(agentId: string, sessionId: string) => void} [onOpenSession] — switch agent + open chat session
 * @param {(projectId: string) => void} [onOpenKanban] — open project board
 * @param {(projectId: string) => void} [onOpenPulls] — open project PR list
 * @param {(url: string) => void} [onOpenExternalUrl] — open GitHub etc. (Electron uses shell)
 */
export default function DashboardView({
  orgId,
  onNavigate,
  onOpenSession,
  onOpenKanban,
  onOpenPulls,
  onOpenExternalUrl,
}) {
  const accountName = getAuthRecord()?.user?.username || 'Account';
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
        <div className="flex justify-end mb-4">
          <button
            type="button"
            onClick={() => onNavigate?.('settings:account')}
            className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm text-gray-300 hover:text-white hover:bg-gray-800/70 transition-colors"
            title="Account settings"
          >
            <UserCircle size={20} className="text-gray-400" />
            <span className="font-medium truncate max-w-[12rem]">{accountName}</span>
          </button>
        </div>
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
            <ActiveSessionsPanel sessions={data.activeSessions} onOpenSession={onOpenSession} />
            <OpenPRsPanel
              prs={data.openPRs}
              onOpenPulls={onOpenPulls}
              onOpenExternalUrl={onOpenExternalUrl}
            />
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

const PR_PRIORITY_DOT = {
  urgent: 'bg-rose-500',
  high: 'bg-orange-400',
  medium: 'bg-amber-400',
  low: 'bg-emerald-400',
};

/**
 * Open pull requests: kanban cards carrying an unmerged `pr_url` that have
 * not yet landed in a Done-ish / shipped column. Sourced from
 * `data.openPRs`, which the server scopes to *Agent Hub repository* PRs only
 * (native `/projects/<id>/pulls/<n>` URLs) — GitHub-hosted PR URLs are
 * excluded. Each row deep-links into the in-app Pull Requests view (via
 * `onOpenPulls`). The `onOpenExternalUrl` fallback is retained defensively
 * for any non-native URL that slips through, with a final fallback to the
 * project's PR list.
 *
 * @param {Array<{cardId, projectId, projectName, prUrl, prNumber, title, cardTitle, authorAgent, priority, updatedAt}>} [prs]
 * @param {(projectId: string) => void} [onOpenPulls]
 * @param {(url: string) => void} [onOpenExternalUrl]
 */
function OpenPRsPanel({ prs = [], onOpenPulls, onOpenExternalUrl }) {
  const list = Array.isArray(prs) ? prs : [];

  const activate = (pr) => {
    const prUrl = pr.prUrl != null ? String(pr.prUrl) : '';
    const native = parseNativePrUrl(prUrl);
    if (native && onOpenPulls) {
      onOpenPulls(native.projectId);
      return;
    }
    if (prUrl && onOpenExternalUrl) {
      onOpenExternalUrl(prUrl);
      return;
    }
    if (pr.projectId && onOpenPulls) {
      onOpenPulls(String(pr.projectId));
    }
  };

  const isActionable = (pr) => {
    const prUrl = pr.prUrl != null ? String(pr.prUrl) : '';
    if (parseNativePrUrl(prUrl) && onOpenPulls) return true;
    if (prUrl && onOpenExternalUrl) return true;
    return Boolean(pr.projectId && onOpenPulls);
  };

  return (
    <section aria-label="Open pull requests" className="mb-8">
      <div className="flex items-baseline justify-between mb-3">
        <h2 className="text-sm font-semibold text-gray-300 uppercase tracking-wider">Open PRs</h2>
        <div className="text-xs text-gray-500">
          {list.length} open PR{list.length === 1 ? '' : 's'}
        </div>
      </div>
      <div
        data-testid="open-prs"
        className="bg-gray-900 border border-gray-800 rounded-xl divide-y divide-gray-800"
      >
        {list.length === 0 ? (
          <div className="px-4 py-6 text-center text-xs text-gray-600">No open pull requests.</div>
        ) : (
          list.map((pr) => {
            const actionable = isActionable(pr);
            const rowClass = actionable
              ? 'w-full text-left px-4 py-3 flex items-center gap-3 transition-colors hover:bg-gray-800/50 cursor-pointer group'
              : 'px-4 py-3 flex items-center gap-3';
            const inner = (
              <>
                <GitPullRequest size={16} className="text-violet-400 flex-shrink-0" />
                <div className="flex-1 min-w-0">
                  <div className="text-sm text-white truncate">{pr.title || pr.cardTitle}</div>
                  <div className="text-[11px] text-gray-500 truncate">
                    {pr.projectName || pr.projectId}
                    {pr.authorAgent ? ` · ${pr.authorAgent}` : ''}
                  </div>
                </div>
                {pr.priority && PR_PRIORITY_DOT[pr.priority] && (
                  <span
                    className={`h-2 w-2 rounded-full flex-shrink-0 ${PR_PRIORITY_DOT[pr.priority]}`}
                    title={`${pr.priority} priority`}
                    aria-hidden
                  />
                )}
                <div className="text-[11px] text-gray-500 flex-shrink-0">
                  {pr.updatedAt ? relativeTime(pr.updatedAt) : ''}
                </div>
              </>
            );
            if (actionable) {
              return (
                <button
                  key={pr.cardId}
                  type="button"
                  className={rowClass}
                  onClick={() => activate(pr)}
                >
                  {inner}
                </button>
              );
            }
            return (
              <div key={pr.cardId} className={rowClass}>
                {inner}
              </div>
            );
          })
        )}
      </div>
    </section>
  );
}

/**
 * In-flight work queue: every non-deleted session in the org that has not yet
 * merged — not just the ones whose CLI is currently streaming. Sourced from
 * `data.activeSessions`, enriched server-side with the session name, agent
 * label/color, resolved lifecycle `state`, and owning user. Sessions that are
 * running tests, under review, pending push, or waiting for user input stay in
 * the queue instead of vanishing the moment the lead agent stops streaming.
 * Each row deep-links into the chat via `onOpenSession(agentId, sessionId)`.
 *
 * @param {Array<{sessionId, sessionName, agentId, agentName, agentColor, engine, model, prompt, state, ownerUserId, ownerName, startedAt, lastActivityAt}>} [sessions]
 * @param {(agentId: string, sessionId: string) => void} [onOpenSession]
 */
function ActiveSessionsPanel({ sessions = [], onOpenSession }) {
  const list = Array.isArray(sessions) ? sessions : [];
  return (
    <section aria-label="Active sessions" className="mb-8">
      <div className="flex items-baseline justify-between mb-3">
        <h2 className="text-sm font-semibold text-gray-300 uppercase tracking-wider">
          Active sessions
        </h2>
        <div className="text-xs text-gray-500">{list.length} in flight</div>
      </div>
      <div
        data-testid="active-sessions"
        className="bg-gray-900 border border-gray-800 rounded-xl divide-y divide-gray-800"
      >
        {list.length === 0 ? (
          <div className="px-4 py-6 text-center text-xs text-gray-600">
            No active sessions. Everything has merged or there is no work in flight.
          </div>
        ) : (
          list.map((s) => {
            const actionable = Boolean(s.agentId && s.sessionId && onOpenSession);
            const rowClass = actionable
              ? 'w-full text-left px-4 py-3 flex items-center gap-3 transition-colors hover:bg-gray-800/50 cursor-pointer group'
              : 'px-4 py-3 flex items-center gap-3';
            const meta = sessionStateMeta(s.state);
            // Time-stamp by the freshest signal: an actively-streaming turn's
            // start, otherwise the session's last activity.
            const stamp = s.startedAt || s.lastActivityAt;
            const inner = (
              <>
                <span
                  className="flex h-4 w-4 flex-shrink-0 items-center justify-center"
                  title={meta.label}
                >
                  <SessionStateIcon state={s.state} size={14} />
                </span>
                <div className="flex-1 min-w-0">
                  <div className="text-sm text-white truncate">
                    {s.sessionName || 'Untitled session'}
                  </div>
                  <div className="text-[11px] text-gray-500 truncate">
                    <span style={s.agentColor ? { color: s.agentColor } : undefined}>
                      {s.agentName || s.agentId}
                    </span>
                    {s.ownerName ? ` · 👤 ${s.ownerName}` : ''}
                    {s.engine ? ` · ${s.engine}` : ''}
                    {s.model ? ` · ${s.model}` : ''}
                    {s.prompt ? ` · ${s.prompt}` : ''}
                  </div>
                </div>
                <div className="flex flex-col items-end flex-shrink-0 gap-0.5">
                  <span className="text-[10px] uppercase tracking-wide text-gray-400">
                    {meta.short}
                  </span>
                  <span className="text-[11px] text-gray-500">
                    {stamp ? relativeTime(stamp) : ''}
                  </span>
                </div>
              </>
            );
            if (actionable) {
              return (
                <button
                  key={s.sessionId}
                  type="button"
                  className={rowClass}
                  onClick={() => onOpenSession(String(s.agentId), String(s.sessionId))}
                >
                  {inner}
                </button>
              );
            }
            return (
              <div key={s.sessionId} className={rowClass}>
                {inner}
              </div>
            );
          })
        )}
      </div>
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

// Canonical chip order for the type filter. Listed explicitly (rather
// than derived from `items`) so a newly-arriving event type still has a
// chip after a live refetch.
const ACTIVITY_TYPE_KEYS = [
  'card_created',
  'card_updated',
  'session_created',
  'escalation',
  'pr_created',
];

const FILTER_STORAGE_KEY = 'dashboard.activityFilter.v1';

function loadFilterFromStorage() {
  try {
    if (typeof localStorage === 'undefined') return [];
    const raw = localStorage.getItem(FILTER_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((t) => ACTIVITY_TYPE_KEYS.includes(t));
  } catch {
    return [];
  }
}

function saveFilterToStorage(types) {
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(FILTER_STORAGE_KEY, JSON.stringify(types));
  } catch {
    /* quota / disabled / private mode — ignore */
  }
}

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
      // Agent Hub-native PR URLs open the in-app Pull Requests view —
      // they're client routes, not external pages.
      const native = parseNativePrUrl(prUrl);
      if (native && onOpenPulls) {
        onOpenPulls(native.projectId);
        return;
      }
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

  // Filter state. An empty set means "All" (no narrowing). Persisted in
  // localStorage so the user's choice survives page reloads; the in-memory
  // state already survives scroll / refetch because RecentActivity stays
  // mounted across `setData(...)` from the parent.
  const [activeTypes, setActiveTypes] = useState(() => new Set(loadFilterFromStorage()));

  const toggleType = (key) => {
    setActiveTypes((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      saveFilterToStorage([...next]);
      return next;
    });
  };

  const clearFilter = () => {
    setActiveTypes(() => {
      saveFilterToStorage([]);
      return new Set();
    });
  };

  const visibleItems =
    activeTypes.size === 0 ? items : items.filter((it) => activeTypes.has(it.type));

  const countsByType = items.reduce((acc, it) => {
    acc[it.type] = (acc[it.type] || 0) + 1;
    return acc;
  }, {});

  return (
    <section aria-label="Recent activity">
      <div className="flex items-baseline justify-between mb-3 gap-3 flex-wrap">
        <h2 className="text-sm font-semibold text-gray-300 uppercase tracking-wider">
          Recent activity
        </h2>
        <div
          role="group"
          aria-label="Filter activity by type"
          data-testid="recent-activity-filter"
          className="flex items-center gap-1.5 flex-wrap"
        >
          <button
            type="button"
            onClick={clearFilter}
            aria-pressed={activeTypes.size === 0}
            data-testid="recent-activity-filter-all"
            className={`text-[11px] px-2 py-1 rounded-md border transition-colors ${
              activeTypes.size === 0
                ? 'bg-blue-500/20 border-blue-500/60 text-blue-200'
                : 'bg-gray-900 border-gray-800 text-gray-400 hover:bg-gray-800 hover:text-gray-200'
            }`}
          >
            All
          </button>
          {ACTIVITY_TYPE_KEYS.map((key) => {
            const iconMeta = ACTIVITY_ICONS[key];
            if (!iconMeta) return null;
            const { Icon, label } = iconMeta;
            const active = activeTypes.has(key);
            const count = countsByType[key] || 0;
            return (
              <button
                key={key}
                type="button"
                onClick={() => toggleType(key)}
                aria-pressed={active}
                data-testid={`recent-activity-filter-${key}`}
                className={`text-[11px] px-2 py-1 rounded-md border flex items-center gap-1.5 transition-colors ${
                  active
                    ? 'bg-blue-500/20 border-blue-500/60 text-blue-200'
                    : 'bg-gray-900 border-gray-800 text-gray-400 hover:bg-gray-800 hover:text-gray-200'
                }`}
              >
                <Icon size={12} aria-hidden />
                <span>{label}</span>
                <span className="tabular-nums text-gray-500">{count}</span>
              </button>
            );
          })}
        </div>
      </div>
      <div
        data-testid="recent-activity"
        className="bg-gray-900 border border-gray-800 rounded-xl divide-y divide-gray-800"
      >
        {visibleItems.length === 0 ? (
          <div className="px-4 py-6 text-center text-xs text-gray-600">
            {items.length === 0
              ? 'No recent activity yet.'
              : 'No activity matches the selected filters.'}
          </div>
        ) : (
          visibleItems.map((item) => {
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
