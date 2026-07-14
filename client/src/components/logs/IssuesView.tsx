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
} from 'lucide-react';
import { api } from '../../utils/api';
import { formatDateTime, relativeTime } from '../../utils/time';
import { severityTone, SEVERITY_NUMBER, type LogRecord } from '../../utils/logStream';
import LogRecordRow from './LogRecordRow';

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
  firstSeen: number;
  lastSeen: number;
  eventCount: number;
  status: 'open' | 'resolved' | 'ignored';
  statusUpdatedAt: number | null;
  statusUpdatedBy: string | null;
  releases?: IssueRelease[];
  samples?: LogRecord[];
}

interface IssuesViewProps {
  projectId: string;
  showToast?: (message: string, kind?: string) => void;
}

const STATUS_TABS: ReadonlyArray<{ key: string; label: string }> = [
  { key: 'open', label: 'Open' },
  { key: 'resolved', label: 'Resolved' },
  { key: 'ignored', label: 'Ignored' },
  { key: '', label: 'All' },
];

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

export default function IssuesView({ projectId, showToast }: IssuesViewProps): React.ReactElement {
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
    void load({ append: false });
  }, [load]);

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
              return (
                <li key={issue.id} className="rounded border border-gray-800 bg-gray-900/40">
                  <button
                    type="button"
                    onClick={() => openDetail(issue)}
                    aria-expanded={isOpen}
                    className="flex w-full items-start gap-2 px-3 py-2 text-left hover:bg-gray-800/40"
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
                        <span title={formatDateTime(issue.lastSeen)}>
                          last {relativeTime(issue.lastSeen) || 'just now'}
                        </span>
                      </span>
                    </span>
                    {statusBadge(issue.status)}
                  </button>

                  {isOpen ? (
                    <div className="border-t border-gray-800 px-3 py-3">
                      <div className="mb-3 flex flex-wrap gap-2">
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
                        <div>
                          <dt className="text-gray-600">First seen</dt>
                          <dd className="text-gray-200">{formatDateTime(issue.firstSeen)}</dd>
                        </div>
                        <div>
                          <dt className="text-gray-600">Last seen</dt>
                          <dd className="text-gray-200">{formatDateTime(issue.lastSeen)}</dd>
                        </div>
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
