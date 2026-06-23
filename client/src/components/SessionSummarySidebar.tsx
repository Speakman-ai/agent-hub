import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { GitPullRequest, Sparkles, Loader2, ChevronDown, Ticket } from 'lucide-react';
import { api } from '../utils/api';
import {
  prNumberFromUrl,
  linkedPrDisplayStatus,
  shouldFetchProjectPullDetail,
} from '../utils/prFormatting';
import { formatInjectedBytes } from '../utils/formatBytes';
import { dedupeSkillInvocations } from '../utils/dedupeSkillInvocations';

function collapsedStorageKey(sessionId: any) {
  return sessionId ? `sessionSummaryCollapsed:${sessionId}` : null;
}

/** Collapsed by default; localStorage value `false` means the user left it expanded. */
function readCollapsedPreference(sessionId: any) {
  const key = collapsedStorageKey(sessionId);
  if (!key) return true;
  try {
    const stored = window.localStorage.getItem(key);
    if (stored === 'false') return false;
    return true;
  } catch {
    return true;
  }
}

/**
 * Session metadata panel: linked PR status + skills.
 *
 * `variant="top"` (default) — full-width strip under the chat TopBar; collapsible.
 * `variant="sidebar"` — inline block for embedding inside the left sidebar.
 * `variant="bottom"` / `panel` — aliases of `top`.
 *
 * `onOpenPrDetail(projectId, prNumber)` — navigate to in-app PR detail (Pull Requests view).
 * `onOpenCard(projectId, cardId)` — navigate to the linked kanban ticket's board.
 */
export default function SessionSummarySidebar({
  sessionId,
  isLive,
  variant = 'top',
  onOpenPrDetail,
  onOpenCard,
}: any) {
  const sessionIdRef = useRef(sessionId);
  sessionIdRef.current = sessionId;

  const [summary, setSummary] = useState<any>(null);
  const [loadError, setLoadError] = useState<any>(null);
  const [summaryInitialLoading, setSummaryInitialLoading] = useState(() => Boolean(sessionId));
  const [pull, setPull] = useState<any>(null);
  const [pullReviews, setPullReviews] = useState<any[]>([]);
  const [collapsed, setCollapsed] = useState(() => readCollapsedPreference(sessionId));

  useLayoutEffect(() => {
    if (!sessionId) {
      setSummary(null);
      setPull(null);
      setPullReviews([]);
      setLoadError(null);
      setSummaryInitialLoading(false);
      return;
    }
    setSummary(null);
    setPull(null);
    setPullReviews([]);
    setLoadError(null);
    setSummaryInitialLoading(true);
    setCollapsed(readCollapsedPreference(sessionId));
  }, [sessionId]);

  const toggleCollapsed = useCallback(() => {
    setCollapsed((prev: any) => {
      const next = !prev;
      const key = collapsedStorageKey(sessionIdRef.current);
      if (key) {
        try {
          window.localStorage.setItem(key, next ? 'true' : 'false');
        } catch {
          /* storage unavailable */
        }
      }
      return next;
    });
  }, []);

  const loadSummary = useCallback(() => {
    const sid = sessionIdRef.current;
    if (!sid) return Promise.resolve();
    return api
      .getSessionSummary(sid)
      .then((data: any) => {
        if (sessionIdRef.current !== sid) return;
        setSummary(data);
        setLoadError(null);
        setSummaryInitialLoading(false);
      })
      .catch((e: any) => {
        if (sessionIdRef.current !== sid) return;
        setLoadError(e?.message || 'Failed to load');
        setSummary(null);
        setSummaryInitialLoading(false);
      });
  }, []);

  useEffect(() => {
    if (!sessionId) return;
    loadSummary();
  }, [sessionId, isLive, loadSummary]);

  useEffect(() => {
    if (!sessionId) return;
    // Tighten the refresh cycle while the session is live so newly-loaded
    // skills and PR status changes surface quickly during execution. The
    // 8s cadence preserves the responsiveness the old 5s SkillInvocationsPanel
    // poll gave us without doubling the request rate of the idle (20s) path.
    const intervalMs = isLive ? 8_000 : 20_000;
    const t = setInterval(() => {
      loadSummary();
    }, intervalMs);
    return () => clearInterval(t);
  }, [sessionId, isLive, loadSummary]);

  const linkedPrUrl =
    summary?.linkedCard?.pr_url ?? summary?.finalizePrUrl ?? summary?.sessionTitlePrUrl ?? null;

  const prNum = useMemo(() => {
    return linkedPrUrl ? prNumberFromUrl(linkedPrUrl) : null;
  }, [linkedPrUrl]);

  const pullDetailRepoAligned = useMemo(
    () => shouldFetchProjectPullDetail(linkedPrUrl, summary?.projectGithubRepo),
    [linkedPrUrl, summary?.projectGithubRepo],
  );

  useEffect(() => {
    setPull(null);
    setPullReviews([]);
    if (!summary?.projectId || prNum == null || !pullDetailRepoAligned) return;
    const n = Number.parseInt(String(prNum), 10);
    if (!Number.isFinite(n) || n < 1) return;
    let cancelled = false;
    api
      .getProjectPullDetail(summary.projectId, n)
      .then((d: any) => {
        if (cancelled) return;
        setPull(d?.pr ?? null);
        setPullReviews(Array.isArray(d?.reviews) ? d.reviews : []);
      })
      .catch(() => {
        if (!cancelled) {
          setPull(null);
          setPullReviews([]);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [summary?.projectId, prNum, linkedPrUrl, pullDetailRepoAligned]);

  const skills = useMemo(() => dedupeSkillInvocations(summary?.skills), [summary?.skills]);

  const prStatus = useMemo(
    () =>
      linkedPrDisplayStatus({
        pr: pull,
        linkedCardReviewStatus: summary?.linkedCard?.review_status,
        reviews: pullReviews,
      }),
    [pull, summary?.linkedCard?.review_status, pullReviews],
  );

  const prTitle = pull?.title || summary?.linkedCard?.title || (prNum ? `PR #${prNum}` : null);

  const canOpenPrDetail =
    typeof onOpenPrDetail === 'function' &&
    summary?.projectId &&
    prNum != null &&
    pullDetailRepoAligned;

  const handleOpenPrDetail = () => {
    if (!canOpenPrDetail) return;
    onOpenPrDetail(summary.projectId, Number.parseInt(String(prNum), 10));
  };

  const linkedCard = summary?.linkedCard ?? null;
  const canOpenTicket =
    typeof onOpenCard === 'function' && Boolean(summary?.projectId) && Boolean(linkedCard?.id);

  const handleOpenTicket = () => {
    if (!canOpenTicket) return;
    onOpenCard(summary.projectId, linkedCard.id);
  };

  if (!sessionId) return null;

  const showSummarySkeleton = summaryInitialLoading && !loadError;
  const isSidebar = variant === 'sidebar';
  const isTop = variant === 'top' || variant === 'bottom' || variant === 'panel';

  const sectionClass = isTop
    ? 'rounded-lg border border-gray-800/80 bg-gray-900/40 p-2.5 shrink-0 min-w-[10rem] max-h-full overflow-y-auto'
    : 'rounded-lg border border-gray-800/80 bg-gray-900/40 p-2.5';

  return (
    <aside
      className={
        isSidebar
          ? 'flex flex-col min-h-0 w-full'
          : isTop
            ? 'w-full shrink-0 flex flex-col border-b border-gray-800/80 bg-gray-950/40'
            : 'hidden lg:flex w-[min(20rem,32vw)] shrink-0 border-l border-gray-800/80 bg-gray-950/40 flex flex-col min-h-0'
      }
      aria-label="Session summary"
    >
      <button
        type="button"
        data-testid="session-summary-toggle"
        onClick={toggleCollapsed}
        aria-expanded={!collapsed}
        className="w-full px-3 py-2 flex items-center gap-2 text-left hover:bg-gray-900/50 transition-colors shrink-0"
      >
        <ChevronDown
          size={14}
          className={`shrink-0 text-gray-500 transition-transform ${collapsed ? '-rotate-90' : ''}`}
          aria-hidden
        />
        <div className="min-w-0 flex-1">
          <p className="text-[10px] uppercase tracking-wide text-gray-500">Session</p>
          <p
            className="text-sm font-semibold text-gray-100 truncate"
            title={summary?.session?.name}
          >
            {summary?.session?.name || (showSummarySkeleton ? 'Loading…' : '—')}
          </p>
        </div>
        <div className="flex items-center gap-1.5 shrink-0 flex-wrap justify-end">
          {collapsed && linkedPrUrl && prStatus ? (
            <span
              data-testid="linked-pr-status-pill-collapsed"
              className={`text-[10px] px-1.5 py-0.5 rounded border border-gray-700/40 ${prStatus.color} ${prStatus.bg}`}
            >
              {prNum ? `#${prNum} · ` : ''}
              {prStatus.label}
            </span>
          ) : null}
          {collapsed && skills.length > 0 && (
            <span className="text-[10px] text-gray-400 tabular-nums">
              {skills.length} skill{skills.length === 1 ? '' : 's'}
            </span>
          )}
          {isLive && (
            <span className="inline-flex items-center gap-1.5 text-[10px] font-medium text-emerald-300 border border-emerald-500/30 bg-emerald-500/10 rounded-full px-2 py-0.5">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
              Live
            </span>
          )}
        </div>
      </button>

      {!collapsed && (
        <div
          className={
            isTop
              ? 'flex gap-3 px-3 pb-3 overflow-x-auto text-xs items-stretch max-h-[min(9rem,24vh)]'
              : `p-3 space-y-3 text-xs ${isSidebar ? '' : 'flex-1 min-h-0 overflow-y-auto'}`
          }
        >
          {loadError && (
            <p className="text-amber-300/90 border border-amber-500/20 rounded-lg px-2 py-1.5 shrink-0">
              {loadError}
            </p>
          )}

          {showSummarySkeleton && (
            <div
              className="flex flex-col items-center justify-center gap-2 py-6 text-gray-500 shrink-0"
              data-testid="session-summary-loading"
              aria-busy="true"
              aria-live="polite"
            >
              <Loader2 className="w-5 h-5 animate-spin text-gray-400" aria-hidden />
              <p className="text-[11px]">Loading…</p>
            </div>
          )}

          {!showSummarySkeleton && (
            <>
              {linkedCard ? (
                <button
                  type="button"
                  data-testid="session-linked-ticket"
                  onClick={handleOpenTicket}
                  disabled={!canOpenTicket}
                  className={`${sectionClass} text-left transition-colors ${
                    canOpenTicket
                      ? 'hover:border-sky-500/50 hover:bg-gray-900/70 cursor-pointer'
                      : 'cursor-default opacity-90'
                  }`}
                >
                  <div className="flex items-center justify-between gap-2 mb-1">
                    <h3 className="text-[11px] font-semibold text-gray-200 flex items-center gap-1.5">
                      <Ticket size={14} className="text-gray-500" />
                      Ticket
                    </h3>
                    {linkedCard.columnName && (
                      <span
                        data-testid="linked-ticket-column-pill"
                        className="text-[10px] px-1.5 py-0.5 rounded border border-gray-700/40 shrink-0 text-gray-300 bg-gray-800/50"
                      >
                        {linkedCard.columnName}
                      </span>
                    )}
                  </div>
                  <p
                    className="text-gray-200 font-medium line-clamp-2"
                    title={linkedCard.title || undefined}
                  >
                    {linkedCard.title || '—'}
                  </p>
                  {canOpenTicket && (
                    <p className="text-sky-400/80 mt-1 text-[10px]">Open ticket →</p>
                  )}
                </button>
              ) : null}

              {linkedPrUrl ? (
                <button
                  type="button"
                  data-testid="session-linked-pr"
                  onClick={handleOpenPrDetail}
                  disabled={!canOpenPrDetail}
                  className={`${sectionClass} text-left transition-colors ${
                    canOpenPrDetail
                      ? 'hover:border-sky-500/50 hover:bg-gray-900/70 cursor-pointer'
                      : 'cursor-default opacity-90'
                  }`}
                >
                  <div className="flex items-center justify-between gap-2 mb-1">
                    <h3 className="text-[11px] font-semibold text-gray-200 flex items-center gap-1.5">
                      <GitPullRequest size={14} className="text-gray-500" />
                      {prNum ? `PR #${prNum}` : 'Linked PR'}
                    </h3>
                    {prStatus && (
                      <span
                        data-testid="linked-pr-status-pill"
                        className={`text-[10px] px-1.5 py-0.5 rounded border border-gray-700/40 shrink-0 ${prStatus.color} ${prStatus.bg}`}
                      >
                        {prStatus.label}
                      </span>
                    )}
                  </div>
                  <p
                    className="text-gray-200 font-medium line-clamp-2"
                    title={prTitle || undefined}
                  >
                    {prTitle || '—'}
                  </p>
                  {!pullDetailRepoAligned && (
                    <p className="text-gray-500 mt-1 text-[10px]">
                      PR is outside this project repo.
                    </p>
                  )}
                  {canOpenPrDetail && (
                    <p className="text-sky-400/80 mt-1 text-[10px]">View PR details →</p>
                  )}
                </button>
              ) : (
                <section className={sectionClass}>
                  <h3 className="text-[11px] font-semibold text-gray-200 flex items-center gap-1.5 mb-1">
                    <GitPullRequest size={14} className="text-gray-500" />
                    Linked PR
                  </h3>
                  <p className="text-gray-500">No PR linked to this session&apos;s board card.</p>
                </section>
              )}

              <section className={sectionClass}>
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
                    {skills.map((s: any) => (
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
            </>
          )}
        </div>
      )}
    </aside>
  );
}
