/**
 * Grouped error-issue view (LOG-GROUP). Lists deduplicated issues with a
 * status filter and cursor pagination, and an expandable detail panel showing
 * release facets, recent raw samples (stack traces / trace-span IDs), and the
 * open/resolved/ignored lifecycle controls.
 *
 * All issue text originates from untrusted ingested records; every field is
 * rendered as text (LOG-TRUST). Sample records reuse `LogRecordRow`.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Loader2,
  AlertCircle,
  CheckCircle2,
  BellOff,
  RotateCcw,
  Tag,
  ChevronRight,
  ChevronDown,
  Search,
  Wrench,
} from 'lucide-react';
import { api } from '../../utils/api';
import { formatDateTime, relativeTime } from '../../utils/time';
import { severityTone, SEVERITY_NUMBER, type LogRecord } from '../../utils/logStream';
import LogRecordRow from './LogRecordRow';
import {
  logIssueActionKey,
  logIssueActionLinks,
  logIssueActionEventIsStale,
  logIssueActionEventIsOutOfOrder,
  logIssueActionLabel,
  type LogIssueAction,
  type LogIssueActionEvent,
  type LogIssueActionLinks,
} from '@shared/utils/logIssueActions';
import { logIssueSeenMs } from '@shared/utils/logIssueTime';
import {
  BULK_ACTION_LABEL,
  BULK_ACTION_STATUS,
  allVisibleSelected,
  applyBulkUpdateToList,
  bulkActionAvailable,
  bulkResultMessage,
  clearSubmittedIds,
  pruneSelection,
  selectedStatuses,
  toggleSelectAll,
  toggleSelectedId,
  type LogIssueBulkAction,
} from '@shared/utils/logIssueSelection';

interface IssueRelease {
  release: string | null;
  commitSha: string | null;
  firstSeen: number;
  lastSeen: number;
  eventCount: number;
}

interface LogIssue {
  id: string;
  projectId: string;
  fingerprint: string;
  title: string | null;
  service: string | null;
  environment: string | null;
  exceptionType: string | null;
  messageTemplate: string | null;
  /** Epoch nanoseconds — convert with `logIssueSeenMs` before formatting. */
  firstSeen: number;
  /** Epoch nanoseconds — convert with `logIssueSeenMs` before formatting. */
  lastSeen: number;
  eventCount: number;
  status: 'open' | 'resolved' | 'ignored';
  statusUpdatedAt: number | null;
  statusUpdatedBy: string | null;
  analyzeSessionId: string | null;
  fixCardId?: string | null;
  fixSessionId?: string | null;
  releases?: IssueRelease[];
  samples?: LogRecord[];
}

interface IssuesViewProps {
  projectId: string;
  showToast?: (message: string, kind?: string) => void;
  onOpenSession?: (target: { sessionId: string; agentId: string }) => void;
}

const STATUS_TABS: ReadonlyArray<{ key: string; label: string }> = [
  { key: 'open', label: 'Open' },
  { key: 'resolved', label: 'Resolved' },
  { key: 'ignored', label: 'Ignored' },
  { key: '', label: 'All' },
];

const BULK_ACTIONS: readonly LogIssueBulkAction[] = ['resolve', 'ignore', 'reopen'];

const BULK_ACTION_ICON: Record<LogIssueBulkAction, typeof CheckCircle2> = {
  resolve: CheckCircle2,
  ignore: BellOff,
  reopen: RotateCcw,
};

const BULK_ACTION_TONE: Record<LogIssueBulkAction, string> = {
  resolve: 'border-emerald-600/40 bg-emerald-600/10 text-emerald-300 hover:bg-emerald-600/20',
  ignore: 'border-gray-600/40 bg-gray-600/10 text-gray-300 hover:bg-gray-600/20',
  reopen: 'border-sky-600/40 bg-sky-600/10 text-sky-300 hover:bg-sky-600/20',
};

function statusBadge(status: LogIssue['status']): React.ReactElement {
  const map: Record<LogIssue['status'], string> = {
    open: 'bg-red-500/15 text-red-300 border-red-500/30',
    resolved: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30',
    ignored: 'bg-gray-500/15 text-gray-400 border-gray-500/30',
  };
  return (
    <span
      className={`rounded border px-1.5 py-0.5 text-[10px] font-semibold uppercase ${map[status]}`}
    >
      {status}
    </span>
  );
}

export default function IssuesView({
  projectId,
  showToast,
  onOpenSession,
}: IssuesViewProps): React.ReactElement {
  const [status, setStatus] = useState('open');
  const [issues, setIssues] = useState<LogIssue[]>([]);
  const [cursor, setCursor] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<LogIssue | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [mutatingId, setMutatingId] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [bulkAction, setBulkAction] = useState<LogIssueBulkAction | null>(null);
  const [analyzingId, setAnalyzingId] = useState<string | null>(null);
  const [fixingId, setFixingId] = useState<string | null>(null);
  const [actionErrors, setActionErrors] = useState<Record<string, string>>({});
  const [actionEvents, setActionEvents] = useState<Record<string, LogIssueActionEvent>>({});
  const actionInFlightRef = useRef(new Set<string>());
  const actionFallbackLinksRef = useRef<Record<string, LogIssueActionLinks>>({});
  const actionEventRef = useRef<Record<string, LogIssueActionEvent>>({});

  // Monotonic request id. Each load captures its seq; a response whose seq is no
  // longer current (the status tab or project changed before it resolved) is
  // dropped so a slow 'open' page can never commit under the 'ignored' tab.
  const loadSeqRef = useRef(0);

  const load = useCallback(
    async (opts: { append: boolean; cursor?: number | null } = { append: false }) => {
      const seq = ++loadSeqRef.current;
      if (opts.append) {
        setLoadingMore(true);
      } else {
        setLoading(true);
        setLoadingMore(false); // a fresh list load supersedes any in-flight append
      }
      setError(null);
      try {
        const params: Record<string, unknown> = { limit: 50 };
        if (status) params.status = status;
        if (opts.append && opts.cursor != null) params.cursor = opts.cursor;
        const page = (await api.listLogIssues(projectId, params)) as {
          issues: LogIssue[];
          nextCursor: number | null;
        };
        if (seq !== loadSeqRef.current) return; // superseded — drop the stale page
        const rows = Array.isArray(page.issues) ? page.issues : [];
        setIssues((prev) => (opts.append ? [...prev, ...rows] : rows));
        setCursor(page.nextCursor ?? null);
      } catch (err) {
        if (seq !== loadSeqRef.current) return;
        setError(err instanceof Error ? err.message : 'Failed to load issues');
      } finally {
        if (seq === loadSeqRef.current) {
          setLoading(false);
          setLoadingMore(false);
        }
      }
    },
    [projectId, status],
  );

  useEffect(() => {
    setExpandedId(null);
    setDetail(null);
    setSelectedIds([]);
    void load({ append: false });
  }, [load]);

  // A reload or a recurrence-driven refresh can retire a ticked row. Keeping
  // its id would batch-transition an issue the user can no longer see.
  useEffect(() => {
    setSelectedIds((prev) => {
      if (prev.length === 0) return prev;
      const next = pruneSelection(
        prev,
        issues.map((issue) => issue.id),
      );
      return next.length === prev.length ? prev : next;
    });
  }, [issues]);

  // The App WebSocket bridge turns the server's project-scoped action events
  // into a DOM event. This keeps the issue detail live when another tab or
  // mobile client starts/fails/completes an action.
  useEffect(() => {
    const onAction = (event: Event) => {
      const data = (event as CustomEvent<LogIssueActionEvent>).detail;
      if (!data || data.projectId !== projectId || !data.issueId) return;
      const key = logIssueActionKey(data.issueId, data.action);
      const previousEvent = actionEventRef.current[key];
      if (logIssueActionEventIsOutOfOrder(previousEvent, data)) return;
      actionEventRef.current[key] = data;
      const reconcile = (
        issue: LogIssue,
        fallbackLinks = actionFallbackLinksRef.current[key],
      ): LogIssue => {
        const links = logIssueActionLinks(issue, data.action);
        if (logIssueActionEventIsStale(links, data)) return issue;
        if (data.status === 'failed') {
          if (fallbackLinks) {
            return data.action === 'analyze'
              ? { ...issue, analyzeSessionId: fallbackLinks.sessionId }
              : {
                  ...issue,
                  fixSessionId: fallbackLinks.sessionId,
                  fixCardId: fallbackLinks.cardId,
                };
          }
          return data.action === 'analyze'
            ? { ...issue, analyzeSessionId: null }
            : { ...issue, fixSessionId: null, fixCardId: null };
        }
        return data.action === 'analyze'
          ? { ...issue, analyzeSessionId: data.sessionId || issue.analyzeSessionId }
          : {
              ...issue,
              fixSessionId: data.sessionId || issue.fixSessionId,
              fixCardId: data.cardId || issue.fixCardId,
            };
      };
      const captureFallback = (issue: LogIssue): void => {
        const links = logIssueActionLinks(issue, data.action);
        const replacesExisting =
          (data.sessionId && links.sessionId && data.sessionId !== links.sessionId) ||
          (data.cardId && links.cardId && data.cardId !== links.cardId);
        if (
          data.status === 'in_flight' &&
          replacesExisting &&
          (links.sessionId || links.cardId) &&
          !actionFallbackLinksRef.current[key]
        ) {
          actionFallbackLinksRef.current[key] = links;
        }
      };
      setActionEvents((prev) => ({ ...prev, [key]: data }));
      if (data.status === 'failed') {
        setActionErrors((prev) => ({ ...prev, [key]: data.error || 'Action failed' }));
        setIssues((prev) =>
          prev.map((issue) => (issue.id === data.issueId ? reconcile(issue) : issue)),
        );
        setDetail((prev) => (prev?.id === data.issueId ? reconcile(prev) : prev));
      } else if (data.status === 'in_flight') {
        setActionErrors((prev) => {
          if (!prev[key]) return prev;
          const next = { ...prev };
          delete next[key];
          return next;
        });
        setIssues((prev) =>
          prev.map((issue) => {
            if (issue.id !== data.issueId) return issue;
            captureFallback(issue);
            return reconcile(issue);
          }),
        );
        setDetail((prev) => {
          if (prev?.id !== data.issueId) return prev;
          captureFallback(prev);
          return reconcile(prev);
        });
      }
      if (data.status === 'completed') {
        delete actionFallbackLinksRef.current[key];
        setIssues((prev) =>
          prev.map((issue) => (issue.id === data.issueId ? reconcile(issue) : issue)),
        );
        setDetail((prev) => (prev?.id === data.issueId ? reconcile(prev) : prev));
      }
    };
    window.addEventListener('agenthub:log_issue_action', onAction);
    return () => window.removeEventListener('agenthub:log_issue_action', onAction);
  }, [projectId]);

  const openDetail = useCallback(
    async (issue: LogIssue) => {
      if (expandedId === issue.id) {
        setExpandedId(null);
        return;
      }
      setExpandedId(issue.id);
      setDetail(null);
      setDetailLoading(true);
      try {
        const full = (await api.getLogIssue(projectId, issue.id)) as LogIssue;
        setDetail(full);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load issue detail');
      } finally {
        setDetailLoading(false);
      }
    },
    [expandedId, projectId],
  );

  const transition = useCallback(
    async (issue: LogIssue, action: 'resolve' | 'ignore' | 'reopen') => {
      setMutatingId(issue.id);
      try {
        const fn =
          action === 'resolve'
            ? api.resolveLogIssue
            : action === 'ignore'
              ? api.ignoreLogIssue
              : api.reopenLogIssue;
        const updated = (await fn(projectId, issue.id)) as LogIssue;
        setIssues((prev) => prev.map((i) => (i.id === issue.id ? { ...i, ...updated } : i)));
        setDetail((prev) => (prev && prev.id === issue.id ? { ...prev, ...updated } : prev));
        showToast?.(`Issue ${updated.status}`, 'success');
      } catch (err) {
        showToast?.(err instanceof Error ? err.message : 'Update failed', 'error');
      } finally {
        setMutatingId(null);
      }
    },
    [projectId, showToast],
  );

  const runBulk = useCallback(
    async (action: LogIssueBulkAction) => {
      if (selectedIds.length === 0 || bulkAction) return;
      // Freeze the ids this request submits. Rows stay tickable while it runs,
      // so only these may be cleared on completion — anything ticked meanwhile
      // was never sent and must survive.
      const submitted = selectedIds;
      setBulkAction(action);
      try {
        const result = (await api.bulkSetLogIssueStatus(
          projectId,
          submitted,
          BULK_ACTION_STATUS[action],
        )) as { updated: LogIssue[]; notFound: string[] };
        const updated = Array.isArray(result.updated) ? result.updated : [];
        const notFound = Array.isArray(result.notFound) ? result.notFound : [];
        // On a filtered tab the transitioned rows leave the list, so an
        // expanded panel for one of them has to close with it.
        const removed = new Set(
          updated.filter((row) => status && row.status !== status).map((row) => row.id),
        );
        setIssues((prev) => applyBulkUpdateToList(prev, updated, status));
        setExpandedId((prev) => (prev && removed.has(prev) ? null : prev));
        setDetail((prev) => {
          if (!prev) return prev;
          if (removed.has(prev.id)) return null;
          const patch = updated.find((row) => row.id === prev.id);
          return patch ? { ...prev, ...patch } : prev;
        });
        setSelectedIds((prev) => clearSubmittedIds(prev, submitted));
        showToast?.(bulkResultMessage(action, updated.length, notFound.length), 'success');
      } catch (err) {
        showToast?.(err instanceof Error ? err.message : 'Batch update failed', 'error');
      } finally {
        setBulkAction(null);
      }
    },
    [bulkAction, projectId, selectedIds, showToast, status],
  );

  const runAction = useCallback(
    async (action: LogIssueAction, issue: LogIssue, startAnother = false) => {
      const key = logIssueActionKey(issue.id, action);
      if (actionInFlightRef.current.has(key)) return;
      actionInFlightRef.current.add(key);
      if (startAnother && !actionFallbackLinksRef.current[key]) {
        const links = logIssueActionLinks(issue, action);
        if (links.sessionId || links.cardId) actionFallbackLinksRef.current[key] = links;
      }
      if (action === 'analyze') setAnalyzingId(issue.id);
      else setFixingId(issue.id);
      setActionErrors((prev) => {
        if (!prev[key]) return prev;
        const next = { ...prev };
        delete next[key];
        return next;
      });
      try {
        const result = (await (action === 'analyze'
          ? startAnother
            ? api.analyzeLogIssue(projectId, issue.id, { startAnother: true })
            : api.analyzeLogIssue(projectId, issue.id)
          : startAnother
            ? api.fixLogIssue(projectId, issue.id, { startAnother: true })
            : api.fixLogIssue(projectId, issue.id))) as {
          sessionId: string;
          agentId: string;
          reused: boolean;
          issue: LogIssue;
          cardId?: string;
        };
        setIssues((prev) => prev.map((i) => (i.id === issue.id ? { ...i, ...result.issue } : i)));
        setDetail((prev) => (prev && prev.id === issue.id ? { ...prev, ...result.issue } : prev));
        const completedEvent: LogIssueActionEvent = {
          type: 'log_issue_action',
          projectId,
          issueId: issue.id,
          action,
          status: 'completed',
          sessionId: result.sessionId,
          agentId: result.agentId,
          cardId: result.cardId || result.issue?.fixCardId,
        };
        actionEventRef.current[key] = completedEvent;
        setActionEvents((prev) => ({ ...prev, [key]: completedEvent }));
        delete actionFallbackLinksRef.current[key];
        showToast?.(
          result.reused
            ? `${logIssueActionLabel(action)} ${action === 'analyze' ? 'session' : 'workflow'} reopened`
            : `${logIssueActionLabel(action)} started`,
          'success',
        );
        onOpenSession?.({ sessionId: result.sessionId, agentId: result.agentId });
      } catch (err) {
        const message = err instanceof Error ? err.message : `Failed to start ${action}`;
        const fallbackLinks = actionFallbackLinksRef.current[key];
        if (fallbackLinks) {
          setIssues((prev) =>
            prev.map((current) =>
              current.id !== issue.id
                ? current
                : action === 'analyze'
                  ? { ...current, analyzeSessionId: fallbackLinks.sessionId }
                  : {
                      ...current,
                      fixSessionId: fallbackLinks.sessionId,
                      fixCardId: fallbackLinks.cardId,
                    },
            ),
          );
          setDetail((current) =>
            current?.id !== issue.id
              ? current
              : action === 'analyze'
                ? { ...current, analyzeSessionId: fallbackLinks.sessionId }
                : {
                    ...current,
                    fixSessionId: fallbackLinks.sessionId,
                    fixCardId: fallbackLinks.cardId,
                  },
          );
        }
        setActionErrors((prev) => ({ ...prev, [key]: message }));
        const failedEvent: LogIssueActionEvent = {
          type: 'log_issue_action',
          projectId,
          issueId: issue.id,
          action,
          status: 'failed',
          error: message,
        };
        actionEventRef.current[key] = failedEvent;
        setActionEvents((prev) => ({ ...prev, [key]: failedEvent }));
        showToast?.(message, 'error');
      } finally {
        actionInFlightRef.current.delete(key);
        if (action === 'analyze') setAnalyzingId(null);
        else setFixingId(null);
      }
    },
    [onOpenSession, projectId, showToast],
  );

  const visibleIds = issues.map((issue) => issue.id);
  const selectionStatuses = selectedStatuses(issues, selectedIds);

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-1 border-b border-gray-800 pb-2">
        {STATUS_TABS.map((tab) => (
          <button
            key={tab.key || 'all'}
            type="button"
            onClick={() => setStatus(tab.key)}
            className={`rounded px-2.5 py-1 text-xs ${
              status === tab.key
                ? 'bg-gray-700 text-white'
                : 'text-gray-400 hover:bg-gray-800 hover:text-gray-200'
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {error ? (
        <div
          role="alert"
          className="mt-3 flex items-center gap-2 rounded border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-300"
        >
          <AlertCircle size={15} /> {error}
        </div>
      ) : null}

      {!loading && issues.length > 0 ? (
        <div className="mt-2 flex flex-wrap items-center gap-2 border-b border-gray-800 pb-2">
          <label className="inline-flex items-center gap-2 text-xs text-gray-400">
            <input
              type="checkbox"
              aria-label="Select all issues"
              checked={allVisibleSelected(selectedIds, visibleIds)}
              onChange={() => setSelectedIds((prev) => toggleSelectAll(prev, visibleIds))}
              className="h-3.5 w-3.5 accent-emerald-500"
            />
            {selectedIds.length > 0 ? `${selectedIds.length} selected` : 'Select all'}
          </label>
          {selectedIds.length > 0 ? (
            <>
              {BULK_ACTIONS.filter((action) => bulkActionAvailable(selectionStatuses, action)).map(
                (action) => {
                  const Icon = BULK_ACTION_ICON[action];
                  return (
                    <button
                      key={action}
                      type="button"
                      disabled={bulkAction !== null}
                      onClick={() => void runBulk(action)}
                      className={`inline-flex items-center gap-1 rounded border px-2 py-1 text-xs disabled:opacity-50 ${BULK_ACTION_TONE[action]}`}
                    >
                      {bulkAction === action ? (
                        <Loader2 size={13} className="animate-spin" />
                      ) : (
                        <Icon size={13} />
                      )}
                      {BULK_ACTION_LABEL[action]} selected
                    </button>
                  );
                },
              )}
              <button
                type="button"
                onClick={() => setSelectedIds([])}
                className="rounded border border-gray-700 px-2 py-1 text-xs text-gray-400 hover:bg-gray-800"
              >
                Clear
              </button>
            </>
          ) : null}
        </div>
      ) : null}

      <div className="mt-2 min-h-0 flex-1 overflow-y-auto">
        {loading ? (
          <div className="flex items-center justify-center gap-2 p-8 text-sm text-gray-500">
            <Loader2 size={16} className="animate-spin" /> Loading issues…
          </div>
        ) : issues.length === 0 ? (
          <div className="p-8 text-center text-sm text-gray-500">
            No {status || ''} error issues. Grouped errors appear here once an ERROR-level record is
            ingested.
          </div>
        ) : (
          <ul className="space-y-1">
            {issues.map((issue) => {
              const isOpen = expandedId === issue.id;
              const firstSeenMs = logIssueSeenMs(issue.firstSeen);
              const lastSeenMs = logIssueSeenMs(issue.lastSeen);
              return (
                <li key={issue.id} className="rounded border border-gray-800 bg-gray-900/40">
                  <div className="flex items-start">
                    <label className="flex cursor-pointer items-center py-3 pl-3">
                      <input
                        type="checkbox"
                        aria-label={`Select ${issue.title || issue.messageTemplate || 'issue'}`}
                        checked={selectedIds.includes(issue.id)}
                        onChange={() => setSelectedIds((prev) => toggleSelectedId(prev, issue.id))}
                        className="h-3.5 w-3.5 accent-emerald-500"
                      />
                    </label>
                    <button
                      type="button"
                      onClick={() => openDetail(issue)}
                      aria-expanded={isOpen}
                      className="flex min-w-0 flex-1 items-start gap-2 px-3 py-2 text-left hover:bg-gray-800/40"
                    >
                      <span className="mt-1 text-gray-500">
                        {isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                      </span>
                      <span
                        className={`mt-0.5 shrink-0 rounded border px-1 text-[10px] font-semibold uppercase ${severityTone(
                          SEVERITY_NUMBER.ERROR,
                        )}`}
                      >
                        {issue.exceptionType || 'error'}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm text-gray-100">
                          {issue.title || issue.messageTemplate || '(no message)'}
                        </span>
                        <span className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-gray-500">
                          {issue.service ? <span>{issue.service}</span> : null}
                          {issue.environment ? <span>{issue.environment}</span> : null}
                          <span>{issue.eventCount.toLocaleString()} events</span>
                          {lastSeenMs !== null ? (
                            <span title={formatDateTime(lastSeenMs)}>
                              last {relativeTime(lastSeenMs)}
                            </span>
                          ) : null}
                        </span>
                      </span>
                      {statusBadge(issue.status)}
                    </button>
                  </div>

                  {isOpen ? (
                    <div className="border-t border-gray-800 px-3 py-3">
                      <p className="mb-3 rounded border border-gray-800 bg-gray-950/60 px-2 py-1.5 text-[11px] text-gray-400">
                        Analyze is read-only and makes no edits. Fix creates an isolated worktree
                        and inherits your project Finalize automation default.
                      </p>
                      <div className="mb-3 flex flex-wrap gap-2">
                        {(() => {
                          const analyzeKey = logIssueActionKey(issue.id, 'analyze');
                          const fixKey = logIssueActionKey(issue.id, 'fix');
                          const analyzeLinks = logIssueActionLinks(issue, 'analyze');
                          const fixLinks = logIssueActionLinks(issue, 'fix');
                          const analyzeBusy =
                            analyzingId === issue.id ||
                            actionEvents[analyzeKey]?.status === 'in_flight';
                          const fixBusy =
                            fixingId === issue.id || actionEvents[fixKey]?.status === 'in_flight';
                          const fixCompleted = actionEvents[fixKey]?.status === 'completed';
                          const analyzeCompleted = actionEvents[analyzeKey]?.status === 'completed';
                          return (
                            <>
                              <button
                                type="button"
                                disabled={fixBusy}
                                onClick={() => void runAction('fix', detail ?? issue)}
                                aria-label={fixLinks.sessionId ? 'Open fix' : 'Fix'}
                                className="inline-flex items-center gap-1 rounded border border-amber-600/40 bg-amber-600/10 px-2 py-1 text-xs text-amber-300 hover:bg-amber-600/20 disabled:opacity-50"
                              >
                                {fixBusy ? (
                                  <Loader2 size={13} className="animate-spin" />
                                ) : (
                                  <Wrench size={13} />
                                )}
                                {fixBusy
                                  ? 'Starting Fix…'
                                  : fixLinks.sessionId
                                    ? 'Open fix'
                                    : 'Fix'}
                              </button>
                              {fixLinks.sessionId ? (
                                <button
                                  type="button"
                                  onClick={() => void runAction('fix', detail ?? issue, true)}
                                  className="rounded border border-gray-700 px-2 py-1 text-xs text-gray-300 hover:bg-gray-800"
                                >
                                  Start another fix
                                </button>
                              ) : null}
                              <button
                                type="button"
                                disabled={analyzeBusy}
                                onClick={() => void runAction('analyze', detail ?? issue)}
                                aria-label={analyzeLinks.sessionId ? 'Open analysis' : 'Analyze'}
                                className="inline-flex items-center gap-1 rounded border border-violet-600/40 bg-violet-600/10 px-2 py-1 text-xs text-violet-300 hover:bg-violet-600/20 disabled:opacity-50"
                              >
                                {analyzeBusy ? (
                                  <Loader2 size={13} className="animate-spin" />
                                ) : (
                                  <Search size={13} />
                                )}
                                {analyzeBusy
                                  ? 'Starting Analyze…'
                                  : analyzeLinks.sessionId
                                    ? 'Open analysis'
                                    : 'Analyze'}
                              </button>
                              {analyzeLinks.sessionId ? (
                                <button
                                  type="button"
                                  onClick={() => void runAction('analyze', detail ?? issue, true)}
                                  className="rounded border border-gray-700 px-2 py-1 text-xs text-gray-300 hover:bg-gray-800"
                                >
                                  Start another analysis
                                </button>
                              ) : null}
                              {actionErrors[fixKey] ? (
                                <span role="alert" className="basis-full text-xs text-red-300">
                                  Fix failed: {actionErrors[fixKey]}
                                </span>
                              ) : null}
                              {actionErrors[analyzeKey] ? (
                                <span role="alert" className="basis-full text-xs text-red-300">
                                  Analyze failed: {actionErrors[analyzeKey]}
                                </span>
                              ) : null}
                              {fixLinks.cardId ? (
                                <span className="basis-full text-[11px] text-amber-300">
                                  {fixCompleted ? 'Fix completed · ' : 'Fix card linked · '}
                                  {fixLinks.cardId.slice(0, 8)}
                                </span>
                              ) : null}
                              {analyzeLinks.sessionId ? (
                                <span className="basis-full text-[11px] text-violet-300">
                                  {analyzeCompleted
                                    ? 'Analyze completed · '
                                    : 'Analysis session linked · '}
                                  {analyzeLinks.sessionId.slice(0, 8)}
                                </span>
                              ) : null}
                            </>
                          );
                        })()}
                        {issue.status !== 'resolved' ? (
                          <button
                            type="button"
                            disabled={mutatingId === issue.id}
                            onClick={() => transition(issue, 'resolve')}
                            className="inline-flex items-center gap-1 rounded border border-emerald-600/40 bg-emerald-600/10 px-2 py-1 text-xs text-emerald-300 hover:bg-emerald-600/20 disabled:opacity-50"
                          >
                            <CheckCircle2 size={13} /> Resolve
                          </button>
                        ) : null}
                        {issue.status !== 'ignored' ? (
                          <button
                            type="button"
                            disabled={mutatingId === issue.id}
                            onClick={() => transition(issue, 'ignore')}
                            className="inline-flex items-center gap-1 rounded border border-gray-600/40 bg-gray-600/10 px-2 py-1 text-xs text-gray-300 hover:bg-gray-600/20 disabled:opacity-50"
                          >
                            <BellOff size={13} /> Ignore
                          </button>
                        ) : null}
                        {issue.status !== 'open' ? (
                          <button
                            type="button"
                            disabled={mutatingId === issue.id}
                            onClick={() => transition(issue, 'reopen')}
                            className="inline-flex items-center gap-1 rounded border border-sky-600/40 bg-sky-600/10 px-2 py-1 text-xs text-sky-300 hover:bg-sky-600/20 disabled:opacity-50"
                          >
                            <RotateCcw size={13} /> Reopen
                          </button>
                        ) : null}
                      </div>

                      <dl className="mb-3 grid grid-cols-2 gap-x-4 gap-y-1 text-[11px] text-gray-400 sm:grid-cols-4">
                        {/* An unusable timestamp drops the whole term — a label
                            with a blank value beside it reads as a rendering bug. */}
                        {firstSeenMs !== null ? (
                          <div>
                            <dt className="text-gray-600">First seen</dt>
                            <dd className="text-gray-200">{formatDateTime(firstSeenMs)}</dd>
                          </div>
                        ) : null}
                        {lastSeenMs !== null ? (
                          <div>
                            <dt className="text-gray-600">Last seen</dt>
                            <dd className="text-gray-200">{formatDateTime(lastSeenMs)}</dd>
                          </div>
                        ) : null}
                        <div>
                          <dt className="text-gray-600">Events</dt>
                          <dd className="text-gray-200">{issue.eventCount.toLocaleString()}</dd>
                        </div>
                        <div>
                          <dt className="text-gray-600">Fingerprint</dt>
                          <dd
                            className="truncate font-mono text-gray-300"
                            title={issue.fingerprint}
                          >
                            {issue.fingerprint.slice(0, 12)}
                          </dd>
                        </div>
                      </dl>

                      {detailLoading && !detail ? (
                        <div className="flex items-center gap-2 text-xs text-gray-500">
                          <Loader2 size={13} className="animate-spin" /> Loading detail…
                        </div>
                      ) : null}

                      {detail && detail.id === issue.id ? (
                        <>
                          {detail.releases && detail.releases.length > 0 ? (
                            <div className="mb-3">
                              <div className="mb-1 text-[11px] font-semibold text-gray-400">
                                Affected releases
                              </div>
                              <div className="flex flex-wrap gap-1.5">
                                {detail.releases.map((r, idx) => (
                                  <span
                                    key={`${r.release ?? 'none'}-${r.commitSha ?? idx}`}
                                    className="inline-flex items-center gap-1 rounded bg-gray-800 px-1.5 py-0.5 text-[11px] text-gray-300"
                                  >
                                    <Tag size={11} />
                                    {r.release || 'unversioned'}
                                    {r.commitSha ? (
                                      <span className="font-mono text-gray-500">
                                        @{r.commitSha.slice(0, 7)}
                                      </span>
                                    ) : null}
                                    <span className="text-gray-500">
                                      ({r.eventCount.toLocaleString()})
                                    </span>
                                  </span>
                                ))}
                              </div>
                            </div>
                          ) : null}

                          <div className="text-[11px] font-semibold text-gray-400">
                            Recent samples
                          </div>
                          <div className="mt-1 overflow-hidden rounded border border-gray-800">
                            {detail.samples && detail.samples.length > 0 ? (
                              detail.samples.map((s) => <LogRecordRow key={s.id} record={s} />)
                            ) : (
                              <div className="p-3 text-xs text-gray-600">No sample records.</div>
                            )}
                          </div>
                        </>
                      ) : null}
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}

        {cursor != null && !loading ? (
          <div className="mt-2">
            <button
              type="button"
              onClick={() => load({ append: true, cursor })}
              disabled={loadingMore}
              className="inline-flex items-center gap-1 rounded border border-gray-700 px-2 py-1 text-xs text-gray-300 hover:bg-gray-800 disabled:opacity-50"
            >
              {loadingMore ? <Loader2 size={13} className="animate-spin" /> : null}
              Load more
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}
