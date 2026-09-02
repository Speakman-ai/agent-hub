import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import {
  BarChart3,
  CalendarDays,
  GitPullRequest,
  AlertTriangle,
  Plus,
  Pencil,
  Sparkles,
  RefreshCw,
  UserCircle,
  LifeBuoy,
  Folder,
  Check,
  ListPlus,
  Loader2,
  Ticket,
} from 'lucide-react';
import { api } from '../utils/api';
import { hasCalendarScope } from '../utils/googleSurface';
import { createRequestGenerationState, beginRequest } from '@shared/utils/requestGeneration';
import {
  defaultCalendarRange,
  eventTimeLabel,
  localTimeZone,
  sortCalendarEvents,
} from '@shared/utils/calendarEvents';
import { buildCalendarTodoDraft } from '@shared/utils/captureTodo';
import { buildCalendarCardDraft, type CaptureCardDraft } from '@shared/utils/captureCard';
import CaptureToTicketModal from './CaptureToTicketModal';
import { useVisibleIntervalRefresh } from '../hooks/useVisibleIntervalRefresh';
import { getApiBase, getAuthHeaders } from '../utils/connection';
import { getAuthRecord } from '../utils/auth';
import { relativeTime } from '../utils/time';
import { parseNativePrUrl, openPrDashboardStatusBadge } from '../utils/prFormatting';
import SessionStateIcon from './SessionStateIcon';
import { sessionStateMeta, groupSessionsByState } from '@shared/utils/sessionState';
import {
  ALL_OWNERS,
  ownerKeyForUser,
  defaultOwnerFilter,
  buildOwnerOptions,
  filterSessionsByOwner,
} from '@shared/utils/sessionOwnerFilter';

/**
 * Org-wide dashboard. Renders the response from
 * `GET /api/orgs/:id/dashboard`, top to bottom:
 *   - active sessions (every in-flight session that has not merged yet)
 *   - open PRs (cards with an unmerged PR link)
 *   - recent activity feed
 *
 * Refetches when `orgId` changes (so the OrgSwitcher just works), and
 * auto-refreshes every {@link DASHBOARD_REFRESH_MS} while the tab is visible
 * (paused in the background, catch-up on refocus) via `useVisibleIntervalRefresh`.
 */
/**
 * @param {(view: string) => void} [onNavigate] — navigate to a top-level view (e.g. 'settings:account')
 * @param {(agentId: string, sessionId: string) => void} [onOpenSession] — switch agent + open chat session
 * @param {(projectId: string) => void} [onOpenKanban] — open project board
 * @param {(projectId: string) => void} [onOpenPulls] — open project PR list
 * @param {(url: string) => void} [onOpenExternalUrl] — open GitHub etc. (Electron uses shell)
 * @param {(projectId: string, ticketId?: string | null) => void} [onOpenProjectSupport] — open a
 *   project's support queue, optionally focusing a specific ticket's detail on arrival
 */
/** How often the dashboard silently re-polls while the tab is foregrounded. */
const DASHBOARD_REFRESH_MS = 5000;

export default function DashboardView({
  orgId,
  onNavigate,
  onOpenSession,
  onOpenKanban,
  onOpenPulls,
  onOpenExternalUrl,
  onOpenProjectSupport,
}: any) {
  const currentUser = getAuthRecord()?.user || null;
  const accountName = currentUser?.email || currentUser?.username || 'Account';
  const [data, setData] = useState<any>(null);
  const [error, setError] = useState<any>(null);
  const [loading, setLoading] = useState(false);

  // Generation guard shared by the initial load, manual refresh, and the 5s
  // silent poll. Invalidation is keyed on *commit order* (see
  // `@shared/utils/requestGeneration`): a result lands unless a strictly newer
  // request has already committed replacement data, so a silent poll that
  // fails can't discard an older foreground load that later succeeds.
  const mountedRef = useRef(true);
  const genRef = useRef(createRequestGenerationState());
  // The org a result belongs to. The commit-order guard alone can't stop an
  // in-flight request for a *previous* org from landing (its seq is still the
  // newest committed), so each request also confirms its org is still selected
  // before writing — otherwise switching orgs could flash the old org's data.
  const orgIdRef = useRef(orgId);
  orgIdRef.current = orgId;
  useEffect(() => {
    // Strict Mode runs effect cleanup before the second mount; reset to true on
    // each mount so async loads are not permanently ignored after remount.
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const load = useCallback(
    async ({ silent = false }: { silent?: boolean } = {}) => {
      // Captured at call time; a result may only commit while its org is still
      // the selected one.
      const reqOrgId = orgId;
      const orgStillCurrent = () => orgIdRef.current === reqOrgId;
      if (!orgId) {
        if (mountedRef.current && orgStillCurrent()) {
          setData(null);
          setError(null);
          setLoading(false);
        }
        return;
      }
      const req = beginRequest(genRef.current, { silent });
      // Background polls refresh in place: no spinner, and a transient failure
      // keeps the last-good dashboard on screen instead of flashing an error.
      if (!silent) {
        setLoading(true);
        setError(null);
      }
      let committed = false;
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
        if (mountedRef.current && orgStillCurrent() && req.canCommit()) {
          req.commit();
          committed = true;
          setData(json);
          setError(null);
        }
      } catch (err: any) {
        // Only a foreground request surfaces an error; a silent failure commits
        // nothing, so it can't invalidate an older foreground result.
        if (!silent && mountedRef.current && orgStillCurrent() && req.canCommit()) {
          req.commit();
          committed = true;
          setError(err.message || String(err));
          setData(null);
        }
      } finally {
        // Clear the spinner once we've committed, or when this is the foreground
        // request that still owns it (so a superseding poll doesn't strand it).
        if (mountedRef.current && (committed || req.ownsLoading())) setLoading(false);
      }
    },
    [orgId],
  );

  useEffect(() => {
    load();
  }, [load]);

  useVisibleIntervalRefresh(() => load({ silent: true }), DASHBOARD_REFRESH_MS, {
    enabled: !!orgId,
  });

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
            onClick={() => load()}
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
            <WeeklyCalendarPanel onNavigate={onNavigate} />
            <ActiveSessionsPanel
              sessions={data.activeSessions}
              onOpenSession={onOpenSession}
              currentUser={currentUser}
            />
            <OpenPRsPanel
              prs={data.openPRs}
              onOpenPulls={onOpenPulls}
              onOpenExternalUrl={onOpenExternalUrl}
            />
            <SupportIssuesPanel
              onOpenProjectSupport={onOpenProjectSupport}
              onViewAll={onNavigate ? () => onNavigate('support-overview') : undefined}
            />
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
} as Record<string, any>;

function WeeklyCalendarPanel({ onNavigate }: any) {
  const [status, setStatus] = useState<any>(null);
  const [events, setEvents] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<any>(null);
  // Per-event capture state, mirroring CalendarAgendaPage: the event key being
  // captured to todos, the key just captured (transient "Added" flag), and the
  // draft that seeds the create-ticket picker. `captureError` is a separate
  // transient channel from `error` (the load-error branch that blanks the
  // list) so a failed todo POST doesn't wipe the whole event list for a
  // non-critical action.
  const [capturingId, setCapturingId] = useState<string | null>(null);
  const [capturedId, setCapturedId] = useState<string | null>(null);
  const [captureError, setCaptureError] = useState<string | null>(null);
  const [ticketDraft, setTicketDraft] = useState<CaptureCardDraft | null>(null);
  const mountedRef = useRef(true);
  const genRef = useRef(createRequestGenerationState());

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const load = useCallback(async ({ silent = false }: { silent?: boolean } = {}) => {
    const req = beginRequest(genRef.current, { silent });
    if (!silent) {
      setLoading(true);
      setError(null);
    }
    let committed = false;
    try {
      const nextStatus = await api.getGoogleStatus();
      let nextEvents: any[] = [];
      if (nextStatus?.connected && hasCalendarScope(nextStatus)) {
        const body = await api.listGoogleCalendarEvents({
          ...defaultCalendarRange(),
          timeZone: localTimeZone(),
          maxResults: 20,
        });
        nextEvents = sortCalendarEvents(Array.isArray(body?.events) ? body.events : []);
      }
      if (mountedRef.current && req.canCommit()) {
        req.commit();
        committed = true;
        setStatus(nextStatus);
        setEvents(nextEvents);
        setError(null);
      }
    } catch (err: any) {
      if (!silent && mountedRef.current && req.canCommit()) {
        req.commit();
        committed = true;
        setError(err.message || String(err));
        setEvents([]);
      }
    } finally {
      if (mountedRef.current && (committed || req.ownsLoading())) setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // `key` is the row's stable key (folds in the list index) so two same-titled
  // events without an `id` don't share capture/captured state.
  const captureEvent = useCallback(async (event: any, key: string) => {
    setCapturingId(key);
    setCaptureError(null);
    try {
      await api.createTodo(buildCalendarTodoDraft(event));
      if (!mountedRef.current) return;
      setCapturedId(key);
      window.setTimeout(() => {
        if (mountedRef.current) setCapturedId((current) => (current === key ? null : current));
      }, 2000);
    } catch (err: any) {
      // Isolated from the load-error branch: surface a transient inline notice
      // instead of blanking the event list.
      if (mountedRef.current) setCaptureError(err.message || 'Failed to add to todos');
    } finally {
      if (mountedRef.current) setCapturingId((current) => (current === key ? null : current));
    }
  }, []);

  const connected = !!status?.connected;
  const configured = status?.serverConfigured !== false;
  const calendarEnabled = hasCalendarScope(status);
  const canOpenCalendar = connected && onNavigate;
  const canOpenAccount = onNavigate;

  let emptyTitle = 'No events this week';
  let emptyBody = 'Your primary Google Calendar has no events in the next seven days.';
  let actionLabel: string | null = canOpenCalendar ? 'Open Calendar' : null;
  let actionTarget = 'calendar';

  if (!configured && !connected) {
    emptyTitle = 'Google is not configured';
    emptyBody = 'An Admin needs to add the Google OAuth app before Calendar can connect.';
    actionLabel = canOpenAccount ? 'Account settings' : null;
    actionTarget = 'settings:account';
  } else if (!connected) {
    emptyTitle = 'Connect Google to show Calendar';
    emptyBody = 'Link your Google account in Account settings to show this week on the dashboard.';
    actionLabel = canOpenAccount ? 'Account settings' : null;
    actionTarget = 'settings:account';
  } else if (!calendarEnabled) {
    emptyTitle = 'Enable Calendar access';
    emptyBody = `Connected as ${status?.email || 'Google account'}, but Calendar access has not been granted yet.`;
    actionLabel = canOpenCalendar ? 'Open Calendar' : null;
    actionTarget = 'calendar';
  }

  return (
    <section aria-label="This week's calendar" className="mb-8">
      <div className="flex items-baseline justify-between mb-3 gap-3">
        <h2 className="text-sm font-semibold text-gray-300 uppercase tracking-wider flex items-center gap-2">
          <CalendarDays size={14} className="text-blue-400" />
          This week
        </h2>
        <button
          type="button"
          onClick={() => load()}
          disabled={loading}
          className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-gray-400 hover:bg-gray-800 hover:text-gray-200 disabled:opacity-50"
        >
          <RefreshCw size={12} className={loading ? 'animate-spin' : ''} />
          Refresh
        </button>
      </div>
      <div
        data-testid="dashboard-calendar"
        className="bg-gray-900 border border-gray-800 rounded-xl divide-y divide-gray-800"
      >
        {error ? (
          <div className="px-4 py-6 text-center text-xs text-red-400">
            Failed to load Calendar: {error}
          </div>
        ) : loading ? (
          <div className="px-4 py-6 text-center text-xs text-gray-600">Loading Calendar…</div>
        ) : !connected || !calendarEnabled || events.length === 0 ? (
          <div className="px-4 py-6 text-center">
            <div className="text-sm font-medium text-gray-300">{emptyTitle}</div>
            <div className="mx-auto mt-1 max-w-md text-xs text-gray-500">{emptyBody}</div>
            {actionLabel && (
              <button
                type="button"
                onClick={() => onNavigate?.(actionTarget)}
                className="mt-3 inline-flex items-center gap-1.5 rounded-md border border-gray-700 px-2.5 py-1.5 text-xs text-gray-300 hover:bg-gray-800"
              >
                <CalendarDays size={12} />
                {actionLabel}
              </button>
            )}
          </div>
        ) : (
          events.slice(0, 6).map((event: any, index) => {
            const key = event.id || `${event.summary}-${index}`;
            const isCaptured = capturedId === key;
            return (
              <div key={key} className="px-4 py-3 flex gap-3">
                <div className="w-32 flex-shrink-0 text-[11px] text-gray-500">
                  {eventTimeLabel(event)}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="text-sm text-white truncate">{event.summary || '(no title)'}</div>
                  {event.location ? (
                    <div className="mt-0.5 text-[11px] text-gray-500 truncate">
                      {event.location}
                    </div>
                  ) : null}
                </div>
                <div className="flex flex-shrink-0 items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() => captureEvent(event, key)}
                    disabled={capturingId === key}
                    title="Add to todos"
                    className="inline-flex items-center gap-1 rounded border border-gray-700 px-2 py-1 text-[11px] text-gray-300 hover:bg-gray-800 disabled:opacity-50"
                  >
                    {capturingId === key ? (
                      <Loader2 size={12} className="animate-spin" />
                    ) : isCaptured ? (
                      <Check size={12} className="text-emerald-400" />
                    ) : (
                      <ListPlus size={12} />
                    )}
                    {isCaptured ? 'Added' : 'Todo'}
                  </button>
                  <button
                    type="button"
                    onClick={() => setTicketDraft(buildCalendarCardDraft(event))}
                    title="Create ticket"
                    className="inline-flex items-center gap-1 rounded border border-gray-700 px-2 py-1 text-[11px] text-gray-300 hover:bg-gray-800"
                  >
                    <Ticket size={12} />
                    Ticket
                  </button>
                </div>
              </div>
            );
          })
        )}
      </div>
      {captureError && (
        <div className="mt-2 text-[11px] text-red-400" role="alert">
          {captureError}
        </div>
      )}
      {ticketDraft && (
        <CaptureToTicketModal draft={ticketDraft} onClose={() => setTicketDraft(null)} />
      )}
    </section>
  );
}

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
 * @param {Array<{key, cardId, projectId, projectName, prUrl, prNumber, title, cardTitle, authorAgent, priority, updatedAt, mergeable, reviewDecision, reviewStatus}>} [prs]
 * @param {(projectId: string) => void} [onOpenPulls]
 * @param {(url: string) => void} [onOpenExternalUrl]
 */
function OpenPRsPanel({ prs = [], onOpenPulls, onOpenExternalUrl }: any) {
  const list = Array.isArray(prs) ? prs : [];

  const activate = (pr: any) => {
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

  const isActionable = (pr: any) => {
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
          list.map((pr: any) => {
            const actionable = isActionable(pr);
            const statusBadge = openPrDashboardStatusBadge(pr);
            const rowClass = actionable
              ? 'w-full text-left px-4 py-3 flex items-center gap-3 transition-colors hover:bg-gray-800/50 cursor-pointer group'
              : 'px-4 py-3 flex items-center gap-3';
            const inner = (
              <>
                <GitPullRequest size={16} className="text-violet-400 flex-shrink-0" />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 min-w-0">
                    {statusBadge ? (
                      <span
                        data-testid="open-pr-status-badge"
                        className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold flex-shrink-0 ${statusBadge.bg} ${statusBadge.color}`}
                      >
                        {statusBadge.label}
                      </span>
                    ) : null}
                    <div className="text-sm text-white truncate">{pr.title || pr.cardTitle}</div>
                  </div>
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
                  key={pr.key || pr.cardId || pr.prUrl}
                  type="button"
                  className={rowClass}
                  onClick={() => activate(pr)}
                >
                  {inner}
                </button>
              );
            }
            return (
              <div key={pr.key || pr.cardId || pr.prUrl} className={rowClass}>
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
function ActiveSessionRow({ session: s, onOpenSession }: any) {
  const actionable = Boolean(s.agentId && s.sessionId && onOpenSession);
  const rowClass = actionable
    ? 'w-full text-left px-4 py-3 flex items-center gap-3 transition-colors hover:bg-gray-800/50 cursor-pointer group'
    : 'px-4 py-3 flex items-center gap-3';
  const meta = sessionStateMeta(s.state);
  // Time-stamp by the freshest signal: an actively-streaming turn's start,
  // otherwise the session's last activity.
  const stamp = s.startedAt || s.lastActivityAt;
  const inner = (
    <>
      <span className="flex h-4 w-4 flex-shrink-0 items-center justify-center" title={meta.label}>
        <SessionStateIcon state={s.state} size={14} />
      </span>
      <div className="flex-1 min-w-0">
        <div className="text-sm text-white truncate">{s.sessionName || 'Untitled session'}</div>
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
      {/* The status is now carried by the group header, so the row only needs
          its relative timestamp on the right. */}
      <div className="flex flex-col items-end flex-shrink-0">
        <span className="text-[11px] text-gray-500">{stamp ? relativeTime(stamp) : ''}</span>
      </div>
    </>
  );
  if (actionable) {
    return (
      <button
        type="button"
        className={rowClass}
        onClick={() => onOpenSession(String(s.agentId), String(s.sessionId))}
      >
        {inner}
      </button>
    );
  }
  return <div className={rowClass}>{inner}</div>;
}

function ActiveSessionsPanel({ sessions = [], onOpenSession, currentUser = null }: any) {
  const list = Array.isArray(sessions) ? sessions : [];
  const currentUserKey = ownerKeyForUser(currentUser);
  const currentUserName = (currentUser && (currentUser.email || currentUser.username)) || null;
  // Default the queue to *your* sessions; "All users" reveals the rest.
  const [ownerFilter, setOwnerFilter] = useState(() => defaultOwnerFilter(currentUserKey));
  const ownerOptions = buildOwnerOptions(list, { currentUserKey, currentUserName });
  // If the selected owner has dropped out of the list on a refetch, fall back
  // to "All users" so the <select> never shows a stale/blank value.
  const selected = ownerOptions.some((o: any) => o.key === ownerFilter) ? ownerFilter : ALL_OWNERS;
  const filtered = filterSessionsByOwner(list, selected);
  const groups = groupSessionsByState(filtered);
  const filteredByOwner = selected !== ALL_OWNERS;
  return (
    <section aria-label="Active sessions" className="mb-8">
      <div className="flex items-baseline justify-between mb-3 gap-3">
        <h2 className="text-sm font-semibold text-gray-300 uppercase tracking-wider">
          Active sessions
        </h2>
        <div className="flex items-center gap-3">
          {list.length > 0 && (
            <select
              data-testid="active-sessions-owner-filter"
              aria-label="Filter active sessions by user"
              value={selected}
              onChange={(e: any) => setOwnerFilter(e.target.value)}
              className="bg-gray-800 border border-gray-700 rounded-md text-xs text-gray-200 px-2 py-1 focus:outline-none focus:ring-1 focus:ring-blue-500"
            >
              {ownerOptions.map((o: any) => (
                <option key={o.key} value={o.key}>
                  {o.label} ({o.count})
                </option>
              ))}
            </select>
          )}
          <div className="text-xs text-gray-500">{filtered.length} in flight</div>
        </div>
      </div>
      {filtered.length === 0 ? (
        <div
          data-testid="active-sessions"
          className="bg-gray-900 border border-gray-800 rounded-xl px-4 py-6 text-center text-xs text-gray-600"
        >
          {filteredByOwner
            ? 'No active sessions for the selected user.'
            : 'No active sessions. Everything has merged or there is no work in flight.'}
        </div>
      ) : (
        <div data-testid="active-sessions" className="space-y-4">
          {groups.map((group: any) => (
            <div key={group.state} data-testid={`active-sessions-group-${group.state}`}>
              <div className="flex items-baseline justify-between mb-1.5 px-1">
                <h3 className="text-[11px] font-semibold uppercase tracking-wider text-gray-400">
                  {group.meta.label}
                </h3>
                <span className="text-[11px] text-gray-600">{group.sessions.length}</span>
              </div>
              <div className="bg-gray-900 border border-gray-800 rounded-xl divide-y divide-gray-800">
                {group.sessions.map((s: any) => (
                  <ActiveSessionRow key={s.sessionId} session={s} onOpenSession={onOpenSession} />
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

// Support ticket severity → sort rank (most urgent first) and dot color.
// Mirrors the server's ORDER BY so a client-side re-sort keeps the same order.
const SUPPORT_SEVERITY_RANK = { critical: 0, high: 1, medium: 2, low: 3 } as Record<string, any>;

const SUPPORT_SEVERITY_DOT = {
  critical: 'bg-red-500',
  high: 'bg-orange-400',
  medium: 'bg-amber-400',
  low: 'bg-gray-500',
} as Record<string, any>;

// Severity-first, newest-within-severity. Exported for unit testing.
function sortSupportBySeverity(list: any) {
  return [...list].sort((a: any, b: any) => {
    const sa = SUPPORT_SEVERITY_RANK[a.severity] ?? 4;
    const sb = SUPPORT_SEVERITY_RANK[b.severity] ?? 4;
    if (sa !== sb) return sa - sb;
    return (b.created_at || '').localeCompare(a.created_at || '');
  });
}

/**
 * Org-wide support issues, consolidated on the dashboard. Aggregates every
 * project's *new, unread* support tickets into one severity-ordered list
 * (critical → low) via `GET /support-tickets?status=new&unread=true`. This is a
 * "needs triage" inbox: once an operator opens a ticket (stamping `read_at`) or
 * moves it past `new`, it drops off the dashboard. Each row deep-links into
 * that project's support queue AND focuses the clicked ticket's detail through
 * `onOpenProjectSupport(projectId, ticketId)`.
 *
 * This is the single consolidated support surface — it replaces the former
 * top-level "Support Issues" sidebar entry. Per-project Support links (with
 * unread badges) stay in the sidebar for drill-in.
 *
 * @param {(projectId: string, ticketId?: string | null) => void} [onOpenProjectSupport]
 */
function SupportIssuesPanel({ onOpenProjectSupport, onViewAll }: any) {
  const [tickets, setTickets] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<any>(null);

  // Generation guard keyed on commit order (see the main dashboard load and
  // `@shared/utils/requestGeneration`): a result lands unless a strictly newer
  // request has already committed replacement tickets, so a failing silent poll
  // can't discard an older foreground load that later succeeds.
  const mountedRef = useRef(true);
  const genRef = useRef(createRequestGenerationState());
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const load = useCallback(async ({ silent = false }: { silent?: boolean } = {}) => {
    const req = beginRequest(genRef.current, { silent });
    if (!silent) {
      setLoading(true);
      setError(null);
    }
    let committed = false;
    try {
      const data = await api.getAllSupportTickets({ status: 'new', unread: true });
      if (mountedRef.current && req.canCommit()) {
        req.commit();
        committed = true;
        setTickets(Array.isArray(data?.tickets) ? data.tickets : []);
        setError(null);
      }
    } catch (err: any) {
      // Keep the last triage list (and any prior error) on a transient
      // background-poll failure — only a foreground load surfaces a new error,
      // and a silent failure commits nothing so it can't drop an older result.
      if (!silent && mountedRef.current && req.canCommit()) {
        req.commit();
        committed = true;
        setError(err.message || String(err));
      }
    } finally {
      if (mountedRef.current && (committed || req.ownsLoading())) setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  useVisibleIntervalRefresh(() => load({ silent: true }), DASHBOARD_REFRESH_MS);

  const sorted = useMemo(() => sortSupportBySeverity(tickets), [tickets]);

  return (
    <section aria-label="Support issues" className="mb-8">
      <div className="flex items-baseline justify-between mb-3 gap-3 flex-wrap">
        <h2 className="text-sm font-semibold text-gray-300 uppercase tracking-wider flex items-center gap-2">
          <LifeBuoy size={14} className="text-blue-400" />
          New support issues
        </h2>
        {onViewAll ? (
          <button
            onClick={onViewAll}
            className="text-xs text-blue-400 hover:text-blue-300 transition-colors"
          >
            View all
          </button>
        ) : null}
      </div>
      <div
        data-testid="support-issues"
        className="bg-gray-900 border border-gray-800 rounded-xl divide-y divide-gray-800"
      >
        {error ? (
          <div className="px-4 py-6 text-center text-xs text-red-400">
            Failed to load support issues: {error}
          </div>
        ) : loading ? (
          <div className="px-4 py-6 text-center text-xs text-gray-600">Loading support issues…</div>
        ) : sorted.length === 0 ? (
          <div className="px-4 py-6 text-center text-xs text-gray-600">
            No new support issues. Everything is triaged.
          </div>
        ) : (
          sorted.map((t: any) => (
            <SupportIssueRow key={t.id} ticket={t} onOpenProjectSupport={onOpenProjectSupport} />
          ))
        )}
      </div>
    </section>
  );
}

function SupportIssueRow({ ticket, onOpenProjectSupport }: any) {
  const actionable = Boolean(ticket.project_id && onOpenProjectSupport);
  const title = ticket.subject?.trim() || ticket.body?.trim() || '(no subject)';
  const dot = SUPPORT_SEVERITY_DOT[ticket.severity] || SUPPORT_SEVERITY_DOT.low;
  const rowClass = actionable
    ? 'w-full text-left px-4 py-3 flex items-center gap-3 transition-colors hover:bg-gray-800/50 cursor-pointer group'
    : 'px-4 py-3 flex items-center gap-3';
  const inner = (
    <>
      <span
        className={`h-2 w-2 rounded-full flex-shrink-0 ${dot}`}
        title={`${ticket.severity} severity`}
        aria-hidden
      />
      <div className="flex-1 min-w-0">
        <div className="text-sm text-white truncate">{title}</div>
        <div className="text-[11px] text-gray-500 truncate flex items-center gap-1">
          <Folder size={10} className="flex-shrink-0" />
          {ticket.project_name || ticket.project_id}
          {ticket.status ? ` · ${ticket.status}` : ''}
        </div>
      </div>
      <div className="text-[11px] text-gray-500 flex-shrink-0">
        {ticket.created_at ? relativeTime(ticket.created_at) : ''}
      </div>
    </>
  );
  if (actionable) {
    return (
      <button
        type="button"
        data-testid="support-issue-row"
        className={rowClass}
        onClick={() => onOpenProjectSupport(String(ticket.project_id), ticket.id)}
      >
        {inner}
      </button>
    );
  }
  return (
    <div data-testid="support-issue-row" className={rowClass}>
      {inner}
    </div>
  );
}

const ACTIVITY_ICONS = {
  card_created: { Icon: Plus, color: 'text-emerald-400', label: 'Card created' },
  card_updated: { Icon: Pencil, color: 'text-amber-400', label: 'Card updated' },
  session_created: { Icon: Sparkles, color: 'text-blue-400', label: 'Session started' },
  escalation: { Icon: AlertTriangle, color: 'text-rose-400', label: 'Escalation' },
  pr_created: { Icon: GitPullRequest, color: 'text-violet-400', label: 'PR opened' },
} as Record<string, any>;

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
    return parsed.filter((t: any) => ACTIVITY_TYPE_KEYS.includes(t));
  } catch {
    return [];
  }
}

function saveFilterToStorage(types: any) {
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
}: any) {
  const handleRowActivate = (item: any) => {
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

  const rowIsActionable = (item: any) => {
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

  const toggleType = (key: any) => {
    setActiveTypes((prev: any) => {
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
    activeTypes.size === 0 ? items : items.filter((it: any) => activeTypes.has(it.type));

  const countsByType = items.reduce((acc: any, it: any) => {
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
          {ACTIVITY_TYPE_KEYS.map((key: any) => {
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
          visibleItems.map((item: any) => {
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

export { sortSupportBySeverity };
