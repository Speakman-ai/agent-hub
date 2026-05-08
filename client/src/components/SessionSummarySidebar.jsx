import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  CheckCircle2,
  XCircle,
  Clock,
  AlertCircle,
  GitPullRequest,
  Sparkles,
  ChevronsDownUp,
  Copy,
  Loader2,
} from 'lucide-react';
import { api } from '../utils/api.js';
import {
  prNumberFromUrl,
  prStateBadge,
  checkRowStyle,
  checksBadge,
  diffSummary,
  shouldFetchProjectPullDetail,
  summarizeChecks,
} from '../utils/prFormatting.js';
import { shortenPath } from '../utils/diff.js';
import { formatInjectedBytes } from '../utils/formatBytes.js';
import { dedupeSkillInvocations } from '../utils/dedupeSkillInvocations.js';

const CHECK_ICONS = {
  success: CheckCircle2,
  failure: XCircle,
  pending: Clock,
  unknown: AlertCircle,
};

const REVIEW_PILL = {
  awaiting_review: {
    label: 'Review',
    className: 'bg-amber-500/15 text-amber-200 border-amber-500/30',
  },
  reviewing: { label: 'Reviewing', className: 'bg-sky-500/15 text-sky-200 border-sky-500/30' },
  approved: {
    label: 'Approved',
    className: 'bg-emerald-500/15 text-emerald-200 border-emerald-500/30',
  },
  changes_requested: {
    label: 'Changes',
    className: 'bg-red-500/15 text-red-200 border-red-500/30',
  },
};

function kindLabel(k) {
  if (k === 'A') return { text: 'A', className: 'bg-emerald-500/15 text-emerald-200' };
  if (k === 'D') return { text: 'D', className: 'bg-red-500/15 text-red-200' };
  return { text: 'M', className: 'bg-amber-500/15 text-amber-200' };
}

/**
 * Right-hand session metadata panel: linked PR, skills, changed files, run snapshot, context reads.
 * Desktop (lg+): fixed column. Data from GET /api/sessions/:id/summary + optional PR detail.
 */
export default function SessionSummarySidebar({ sessionId, isLive }) {
  const sessionIdRef = useRef(sessionId);
  sessionIdRef.current = sessionId;

  const [summary, setSummary] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [summaryInitialLoading, setSummaryInitialLoading] = useState(() => Boolean(sessionId));
  const [pull, setPull] = useState(null);
  const [pullError, setPullError] = useState(false);
  const [filter, setFilter] = useState('all');
  const [filesOpen, setFilesOpen] = useState(true);
  const [copyOk, setCopyOk] = useState(false);

  // Drop stale summary/PR state as soon as the user switches sessions so the
  // right column never briefly shows the previous session's metadata.
  useLayoutEffect(() => {
    if (!sessionId) {
      setSummary(null);
      setPull(null);
      setPullError(false);
      setLoadError(null);
      setSummaryInitialLoading(false);
      return;
    }
    setSummary(null);
    setPull(null);
    setPullError(false);
    setLoadError(null);
    setSummaryInitialLoading(true);
  }, [sessionId]);

  // Stable callback: session id is read from `sessionIdRef` so rapid `sessionId`
  // changes do not churn interval subscriptions while still ignoring stale responses.
  const loadSummary = useCallback(() => {
    const sid = sessionIdRef.current;
    if (!sid) return Promise.resolve();
    return api
      .getSessionSummary(sid)
      .then((data) => {
        if (sessionIdRef.current !== sid) return;
        setSummary(data);
        setLoadError(null);
        setSummaryInitialLoading(false);
      })
      .catch((e) => {
        if (sessionIdRef.current !== sid) return;
        setLoadError(e?.message || 'Failed to load');
        setSummary(null);
        setSummaryInitialLoading(false);
      });
  }, []);

  // Refresh on session change / live-state edges only — not on every new chat
  // message (messages.length would re-hit the expensive summary endpoint each turn).
  useEffect(() => {
    if (!sessionId) return;
    loadSummary();
  }, [sessionId, isLive, loadSummary]);

  useEffect(() => {
    if (!sessionId) return;
    const t = setInterval(() => {
      loadSummary();
    }, 20_000);
    return () => clearInterval(t);
  }, [sessionId, loadSummary]);

  /** Card `pr_url` first; else Resolve/Review-style session title (see server/session-title-pr.ts). */
  const linkedPrUrl = summary?.linkedCard?.pr_url ?? summary?.sessionTitlePrUrl ?? null;

  const prNum = useMemo(() => {
    return linkedPrUrl ? prNumberFromUrl(linkedPrUrl) : null;
  }, [linkedPrUrl]);

  const pullDetailRepoAligned = useMemo(
    () => shouldFetchProjectPullDetail(linkedPrUrl, summary?.projectGithubRepo),
    [linkedPrUrl, summary?.projectGithubRepo],
  );

  useEffect(() => {
    setPull(null);
    setPullError(false);
    if (!summary?.projectId || prNum == null || !pullDetailRepoAligned) return;
    const n = Number.parseInt(String(prNum), 10);
    if (!Number.isFinite(n) || n < 1) return;
    let cancelled = false;
    api
      .getProjectPullDetail(summary.projectId, n)
      .then((d) => {
        if (cancelled) return;
        // The endpoint returns `{ repo, source, pr: {...}, reviews, comments, checks }`.
        // Unwrap so this component can keep reading fields off `pull` directly
        // (`pull.title`, `pull.state`, `pull.head`, etc.).
        setPull(d?.pr ? { ...d.pr, checks: Array.isArray(d.checks) ? d.checks : [] } : null);
      })
      .catch(() => {
        if (!cancelled) setPullError(true);
      });
    return () => {
      cancelled = true;
    };
  }, [summary?.projectId, prNum, linkedPrUrl, pullDetailRepoAligned]);

  const run = summary?.runSnapshot;
  const files = run?.files || [];
  const visibleFiles = useMemo(() => {
    if (filter === 'all') return files;
    return files.filter((f) => f.group === filter);
  }, [files, filter]);

  // Collapse repeated <agenthub:skill> loads for the same skill into a single
  // sidebar pill (most-recent invocation wins). Without this, hot-reloads or
  // skill re-loads across turns produce duplicate rows in the Skills section.
  const skills = useMemo(() => dedupeSkillInvocations(summary?.skills), [summary?.skills]);

  const copyText = useMemo(() => {
    if (!summary) return '';
    const lines = [
      'Session summary',
      summary.session?.name ? `Name: ${summary.session.name}` : null,
    ];
    if (linkedPrUrl) {
      const st = pull ? prStateBadge(pull) : { label: 'PR' };
      lines.push(`PR: ${linkedPrUrl} (${st.label})`);
    }
    const sk = skills.map((s) => s.skillId);
    if (sk.length) lines.push(`Skills: ${sk.join(', ')}`);
    if (files.length) {
      const parts = [
        `${files.length} file${files.length === 1 ? '' : 's'}`,
        ...['frontend', 'backend', 'tests'].map(
          (g) => `${g}: ${files.filter((f) => f.group === g).length}`,
        ),
      ];
      lines.push(`Changed: ${parts.join(' · ')}`);
    }
    if (run) {
      lines.push(
        `Tools: ${run.toolCalls} · Retries: ${run.retries} · Error events: ${run.warnings} · Tool errors: ${run.toolErrors}`,
      );
    }
    return lines.filter(Boolean).join('\n');
  }, [summary, pull, files, run, linkedPrUrl, skills]);

  const copySummary = async () => {
    if (!copyText) return;
    try {
      await navigator.clipboard.writeText(copyText);
      setCopyOk(true);
      setTimeout(() => setCopyOk(false), 1200);
    } catch {
      setCopyOk(false);
    }
  };

  if (!sessionId) return null;

  const showSummarySkeleton = summaryInitialLoading && !loadError;

  return (
    <aside
      className="hidden lg:flex w-[min(20rem,32vw)] shrink-0 border-l border-gray-800/80 bg-gray-950/40 flex flex-col min-h-0"
      aria-label="Session summary"
    >
      <div className="p-3 border-b border-gray-800/60 flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-[10px] uppercase tracking-wide text-gray-500">Session</p>
          <h2
            className="text-sm font-semibold text-gray-100 truncate"
            title={summary?.session?.name}
          >
            {summary?.session?.name || (showSummarySkeleton ? 'Loading…' : '—')}
          </h2>
        </div>
        {isLive && (
          <span className="inline-flex items-center gap-1.5 text-[10px] font-medium text-emerald-300 border border-emerald-500/30 bg-emerald-500/10 rounded-full px-2 py-0.5 shrink-0">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
            Live
          </span>
        )}
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto p-3 space-y-3 text-xs">
        {loadError && (
          <p className="text-amber-300/90 border border-amber-500/20 rounded-lg px-2 py-1.5">
            {loadError}
          </p>
        )}

        {showSummarySkeleton && (
          <div
            className="flex flex-col items-center justify-center gap-2 py-10 text-gray-500"
            data-testid="session-summary-loading"
            aria-busy="true"
            aria-live="polite"
          >
            <Loader2 className="w-6 h-6 animate-spin text-gray-400" aria-hidden />
            <p className="text-[11px] text-center px-2">Loading session details…</p>
          </div>
        )}

        {!showSummarySkeleton && (
          <>
            {run?.aggregationSkipped && (
              <p
                className="text-amber-200/90 border border-amber-500/30 bg-amber-500/10 rounded-lg px-2 py-1.5"
                title="This session exceeds the event scan cap; full run snapshot is skipped to protect database load."
              >
                Run snapshot not aggregated (
                {run?.sessionEventCount != null ? run.sessionEventCount.toLocaleString() : 'large'}{' '}
                events). PR and skills still load.
              </p>
            )}

            {/* PR */}
            <section className="rounded-lg border border-gray-800/80 bg-gray-900/40 p-2.5">
              <div className="flex items-center justify-between gap-2 mb-1.5">
                <h3 className="text-[11px] font-semibold text-gray-200 flex items-center gap-1.5">
                  <GitPullRequest size={14} className="text-gray-500" />
                  Linked PR
                </h3>
                <div className="flex items-center gap-1 flex-wrap justify-end">
                  {pull &&
                    (() => {
                      const st = prStateBadge(pull);
                      return (
                        <span
                          data-testid="pr-state-pill"
                          className={`text-[10px] px-1.5 py-0.5 rounded border border-gray-700/40 capitalize ${st.color} ${st.bg}`}
                          title={`PR is ${st.label}`}
                        >
                          {st.label}
                        </span>
                      );
                    })()}
                  {summary?.linkedCard?.review_status &&
                    REVIEW_PILL[summary.linkedCard.review_status] && (
                      <span
                        className={`text-[10px] px-1.5 py-0.5 rounded border ${
                          REVIEW_PILL[summary.linkedCard.review_status].className
                        }`}
                      >
                        {REVIEW_PILL[summary.linkedCard.review_status].label}
                      </span>
                    )}
                </div>
              </div>
              {linkedPrUrl ? (
                <>
                  <p
                    className="text-gray-200 font-medium line-clamp-2"
                    title={
                      pull?.title || summary.linkedCard?.title || summary.session?.name || undefined
                    }
                  >
                    {pull?.title || summary.linkedCard?.title || summary.session?.name || '—'}
                  </p>
                  {pull?.head && (
                    <p className="text-gray-500 mt-0.5 truncate">
                      {pull.head} → {pull?.base || 'main'}
                    </p>
                  )}
                  <a
                    href={linkedPrUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="text-sky-400 hover:text-sky-300 mt-1 inline-block"
                  >
                    #{prNum} · Open on GitHub
                  </a>
                  {pull && diffSummary(pull) && (
                    <p className="text-gray-500 mt-1 tabular-nums">{diffSummary(pull)}</p>
                  )}
                  {pullError && (
                    <p className="text-gray-500 mt-1">Could not load CI status from GitHub.</p>
                  )}
                  {pull && Array.isArray(pull.checks) && pull.checks.length > 0 && (
                    <>
                      {(() => {
                        const cs = summarizeChecks(pull.checks);
                        const cb = checksBadge(cs);
                        return (
                          <div className="mt-2 flex items-center gap-1.5">
                            <span
                              data-testid="checks-rollup-pill"
                              className={`text-[10px] px-1.5 py-0.5 rounded border border-gray-700/40 ${cb.color} ${cb.bg}`}
                              title={`${cs.success} passed · ${cs.failure} failing · ${cs.pending} running`}
                            >
                              {cb.label}
                            </span>
                            {cs.pending > 0 && (
                              <Loader2
                                size={12}
                                className="text-yellow-400 animate-spin"
                                aria-label="Checks running"
                              />
                            )}
                          </div>
                        );
                      })()}
                      <ul className="mt-2 space-y-1" aria-label="Check runs">
                        {pull.checks.slice(0, 8).map((chk, i) => {
                          const st = checkRowStyle(chk);
                          const Icon = CHECK_ICONS[st.iconKey] || AlertCircle;
                          return (
                            <li key={i} className={`flex items-center gap-1.5 ${st.color}`}>
                              <Icon size={12} className="shrink-0" />
                              <span className="truncate" title={chk.name}>
                                {chk.name || 'Check'}
                              </span>
                            </li>
                          );
                        })}
                      </ul>
                    </>
                  )}
                </>
              ) : (
                <p className="text-gray-500">No PR linked to this session&apos;s board card.</p>
              )}
            </section>

            {/* Skills */}
            <section className="rounded-lg border border-gray-800/80 bg-gray-900/40 p-2.5">
              <div className="flex items-center justify-between gap-2 mb-2">
                <h3 className="text-[11px] font-semibold text-gray-200 flex items-center gap-1.5">
                  <Sparkles size={14} className="text-sky-400/80" />
                  Skills
                </h3>
                <span className="text-[10px] text-gray-500">{skills.length}</span>
              </div>
              {!summary || skills.length === 0 ? (
                <p className="text-gray-500">No skills loaded yet.</p>
              ) : (
                <div className="flex flex-wrap gap-1">
                  {skills.map((s) => (
                    <span
                      key={s.skillId ?? s.id}
                      className="px-1.5 py-0.5 rounded border border-gray-700/60 bg-gray-800/50 text-gray-200 text-[10px]"
                      title={
                        s.injectedBytes != null
                          ? formatInjectedBytes(s.injectedBytes)
                          : s.status || undefined
                      }
                    >
                      {s.skillId}
                    </span>
                  ))}
                </div>
              )}
            </section>

            {/* Files */}
            <section className="rounded-lg border border-gray-800/80 bg-gray-900/40 p-2.5">
              <div className="flex items-center justify-between gap-2 mb-2">
                <h3 className="text-[11px] font-semibold text-gray-200">Changed files</h3>
                <button
                  type="button"
                  onClick={() => setFilesOpen((o) => !o)}
                  className="text-[10px] text-gray-400 hover:text-gray-200 flex items-center gap-0.5"
                  aria-expanded={filesOpen}
                >
                  <ChevronsDownUp size={12} />
                  {filesOpen ? 'Collapse' : 'Expand'}
                </button>
              </div>
              <div className="flex flex-wrap gap-1 mb-2" role="tablist">
                {['all', 'frontend', 'backend', 'tests'].map((k) => (
                  <button
                    key={k}
                    type="button"
                    role="tab"
                    onClick={() => setFilter(k)}
                    className={`px-1.5 py-0.5 rounded text-[10px] border ${
                      filter === k
                        ? 'bg-sky-500/20 border-sky-500/40 text-sky-200'
                        : 'border-gray-700/50 text-gray-400 hover:text-gray-200'
                    }`}
                  >
                    {k === 'all' ? 'All' : k[0].toUpperCase() + k.slice(1)}
                  </button>
                ))}
              </div>
              {filesOpen &&
                (visibleFiles.length === 0 ? (
                  <p className="text-gray-500">No file touches recorded in stream events yet.</p>
                ) : (
                  <ul className="space-y-1.5 max-h-48 overflow-y-auto pr-0.5">
                    {visibleFiles.map((f) => {
                      const kl = kindLabel(f.kind);
                      return (
                        <li
                          key={f.path}
                          className="flex items-start justify-between gap-2 text-[10px] text-gray-300"
                        >
                          <span className="font-mono truncate" title={f.path}>
                            {shortenPath(f.path)}
                          </span>
                          <span className="shrink-0 text-gray-500 tabular-nums">
                            +{f.addLines} / -{f.delLines}
                          </span>
                          <span
                            className={`shrink-0 text-[9px] px-1 rounded font-medium ${kl.className}`}
                          >
                            {kl.text}
                          </span>
                        </li>
                      );
                    })}
                  </ul>
                ))}
            </section>

            {/* Run snapshot */}
            {run && (
              <section className="rounded-lg border border-gray-800/80 bg-gray-900/40 p-2.5">
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <h3 className="text-[11px] font-semibold text-gray-200 mb-1.5">Run snapshot</h3>
                    <ul className="space-y-0.5 text-gray-400">
                      <li className="flex justify-between gap-2">
                        <span>Tool calls</span>
                        <strong className="text-gray-200 tabular-nums">{run.toolCalls}</strong>
                      </li>
                      <li className="flex justify-between gap-2">
                        <span>Retries</span>
                        <strong className="text-gray-200 tabular-nums">{run.retries}</strong>
                      </li>
                      <li className="flex justify-between gap-2">
                        <span>Error events</span>
                        <strong className="text-gray-200 tabular-nums">{run.warnings}</strong>
                      </li>
                      <li className="flex justify-between gap-2">
                        <span>Tool errors</span>
                        <strong className="text-gray-200 tabular-nums">{run.toolErrors}</strong>
                      </li>
                    </ul>
                  </div>
                  <button
                    type="button"
                    onClick={copySummary}
                    className="shrink-0 flex items-center gap-1 text-[10px] px-2 py-1 rounded border border-gray-600/60 text-gray-300 hover:bg-gray-800/60"
                  >
                    <Copy size={12} />
                    {copyOk ? 'Copied' : 'Copy'}
                  </button>
                </div>
              </section>
            )}

            {/* Context reads */}
            {run && run.contextReads && run.contextReads.length > 0 && (
              <section className="rounded-lg border border-gray-800/80 bg-gray-900/40 p-2.5">
                <div className="flex items-center justify-between gap-2 mb-1">
                  <h3 className="text-[11px] font-semibold text-gray-200">Context (reads)</h3>
                  <span className="text-[10px] text-gray-500">{run.contextReads.length}</span>
                </div>
                <p className="text-[10px] text-gray-400 font-mono break-all leading-relaxed">
                  {run.contextReads.map(shortenPath).join(' · ')}
                </p>
              </section>
            )}
          </>
        )}
      </div>
    </aside>
  );
}
