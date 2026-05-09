import { useEffect, useMemo, useState } from 'react';
import {
  ChevronDown,
  ChevronRight,
  Clock3,
  GitPullRequest,
  CheckCircle2,
  XCircle,
  Clock,
  AlertCircle,
  Loader2,
} from 'lucide-react';
import { api } from '../utils/api.js';
import {
  prNumberFromUrl,
  prStateBadge,
  checksBadge,
  summarizeChecks,
  shouldFetchProjectPullDetail,
} from '../utils/prFormatting.js';

function formatTime(ts) {
  if (!Number.isFinite(ts)) return '';
  try {
    return new Date(ts).toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  } catch {
    return '';
  }
}

const CHECK_ICONS = {
  success: CheckCircle2,
  failure: XCircle,
  pending: Clock,
  unknown: AlertCircle,
};

const REVIEW_PILL = {
  awaiting_review: {
    label: 'Awaiting review',
    className: 'bg-amber-500/15 text-amber-200 border-amber-500/30',
  },
  reviewing: {
    label: 'Reviewing',
    className: 'bg-sky-500/15 text-sky-200 border-sky-500/30',
  },
  approved: {
    label: 'Approved',
    className: 'bg-emerald-500/15 text-emerald-200 border-emerald-500/30',
  },
  changes_requested: {
    label: 'Changes requested',
    className: 'bg-red-500/15 text-red-200 border-red-500/30',
  },
};

/**
 * Lightweight session orchestration timeline: phase + host loop + progress + delegation.
 *
 * When `sessionId` is provided, also fetches and shows PR review progress
 * (review state, reviewer status, blocking checks) at the top of the panel.
 *
 * Pass `compact` to suppress the outer padding/max-width wrapper (for sidebar use).
 */
export default function OrchestrationTimelinePanel({ entries, sessionId, compact = false }) {
  const [open, setOpen] = useState(true);
  const [prSummary, setPrSummary] = useState(null);

  const visible = useMemo(
    () =>
      (Array.isArray(entries) ? entries : [])
        .filter((e) => e && typeof e.summary === 'string' && e.summary.trim())
        .slice(-20),
    [entries],
  );

  // Fetch PR review state from session summary when sessionId is provided
  useEffect(() => {
    if (!sessionId) return;
    let cancelled = false;
    api
      .getSessionSummary(sessionId)
      .then((data) => {
        if (cancelled) return;
        const linkedCard = data?.linkedCard ?? null;
        const sessionTitlePrUrl = data?.sessionTitlePrUrl ?? null;
        const linkedPrUrl = linkedCard?.pr_url ?? sessionTitlePrUrl ?? null;
        const reviewStatus = linkedCard?.review_status ?? null;
        const projectId = data?.projectId ?? null;
        const prNum = linkedPrUrl ? prNumberFromUrl(linkedPrUrl) : null;

        if (!linkedPrUrl || prNum == null) {
          setPrSummary(null);
          return;
        }

        // Fetch PR detail (checks) only when project + PR number are available,
        // and only when the PR URL refers to the same repo as the project.
        // Cross-repo links (or title-inferred URLs) must not trigger a lookup
        // against /api/projects/:id/pulls/:n — that would hit the wrong repo.
        const repoAligned = shouldFetchProjectPullDetail(linkedPrUrl, data?.projectGithubRepo);
        if (projectId && repoAligned) {
          api
            .getProjectPullDetail(projectId, Number(prNum))
            .then((d) => {
              if (cancelled) return;
              const pr = d?.pr ?? null;
              setPrSummary({
                url: linkedPrUrl,
                prNum,
                title: pr?.title ?? linkedCard?.title ?? null,
                state: pr ? prStateBadge(pr) : null,
                reviewStatus,
                checks: Array.isArray(d?.checks) ? d.checks : [],
              });
            })
            .catch(() => {
              if (cancelled) return;
              // Still show basic PR info even if checks fail
              setPrSummary({
                url: linkedPrUrl,
                prNum,
                title: linkedCard?.title ?? null,
                state: null,
                reviewStatus,
                checks: [],
              });
            });
        } else {
          setPrSummary({
            url: linkedPrUrl,
            prNum,
            title: linkedCard?.title ?? null,
            state: null,
            reviewStatus,
            checks: [],
          });
        }
      })
      .catch(() => {
        if (cancelled) return;
        setPrSummary(null);
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  if (visible.length === 0 && !prSummary) return null;

  const inner = (
    <>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center gap-2 text-left text-xs font-semibold text-gray-300 hover:text-white border border-gray-700/80 rounded-lg px-3 py-2 bg-gray-900/40"
      >
        {open ? (
          <ChevronDown className="w-4 h-4 shrink-0" />
        ) : (
          <ChevronRight className="w-4 h-4 shrink-0" />
        )}
        <Clock3 className="w-4 h-4 text-amber-400 shrink-0" />
        <span>Orchestration timeline</span>
        <span className="text-gray-500 font-normal ml-auto">{visible.length} events</span>
      </button>

      {open && (
        <div className="mt-2 rounded-lg border border-gray-700/80 bg-gray-950/50 p-3 space-y-2">
          {/* PR Review Progress — pinned at top of timeline when available */}
          {prSummary && (
            <div className="pb-2 mb-2 border-b border-gray-700/50">
              <div className="flex items-center gap-1.5 mb-1.5">
                <GitPullRequest size={12} className="text-gray-400 shrink-0" />
                <a
                  href={prSummary.url}
                  target="_blank"
                  rel="noreferrer"
                  className="text-sky-400 hover:text-sky-300 text-[11px] font-medium truncate"
                  title={prSummary.title || prSummary.url}
                >
                  #{prSummary.prNum}
                  {prSummary.title ? ` · ${prSummary.title}` : ''}
                </a>
              </div>

              {/* State + review status pills */}
              <div className="flex flex-wrap items-center gap-1">
                {prSummary.state && (
                  <span
                    className={`text-[10px] px-1.5 py-0.5 rounded border border-gray-700/40 capitalize ${prSummary.state.color} ${prSummary.state.bg}`}
                  >
                    {prSummary.state.label}
                  </span>
                )}
                {prSummary.reviewStatus && REVIEW_PILL[prSummary.reviewStatus] && (
                  <span
                    className={`text-[10px] px-1.5 py-0.5 rounded border ${REVIEW_PILL[prSummary.reviewStatus].className}`}
                  >
                    {REVIEW_PILL[prSummary.reviewStatus].label}
                  </span>
                )}
                {prSummary.checks.length > 0 &&
                  (() => {
                    const cs = summarizeChecks(prSummary.checks);
                    const cb = checksBadge(cs);
                    return (
                      <span
                        className={`text-[10px] px-1.5 py-0.5 rounded border border-gray-700/40 flex items-center gap-1 ${cb.color} ${cb.bg}`}
                        title={`${cs.success} passed · ${cs.failure} failing · ${cs.pending} running`}
                      >
                        {cb.label}
                        {cs.pending > 0 && (
                          <Loader2 size={10} className="animate-spin" aria-label="Checks running" />
                        )}
                      </span>
                    );
                  })()}
              </div>

              {/* Individual failing / pending checks (compact) */}
              {prSummary.checks.length > 0 &&
                (() => {
                  const relevant = prSummary.checks.filter(
                    (c) => c.conclusion === 'failure' || c.status === 'in_progress',
                  );
                  if (relevant.length === 0) return null;
                  return (
                    <ul className="mt-1.5 space-y-0.5">
                      {relevant.slice(0, 5).map((chk, i) => {
                        const isFail = chk.conclusion === 'failure';
                        const Icon = isFail ? XCircle : Clock;
                        return (
                          <li
                            key={i}
                            className={`flex items-center gap-1 text-[10px] ${isFail ? 'text-red-300' : 'text-yellow-300'}`}
                          >
                            <Icon size={10} className="shrink-0" />
                            <span className="truncate">{chk.name || 'Check'}</span>
                          </li>
                        );
                      })}
                    </ul>
                  );
                })()}
            </div>
          )}

          {/* Orchestration events */}
          {visible.map((entry) => (
            <div key={entry.id} className="text-xs text-gray-300 flex items-start gap-2">
              <span className="text-[10px] text-gray-500 shrink-0 pt-0.5 w-16">
                {formatTime(entry.ts)}
              </span>
              <span className="text-gray-400 shrink-0">{entry.kind}</span>
              <span className="text-gray-200">{entry.summary}</span>
            </div>
          ))}
        </div>
      )}
    </>
  );

  if (compact) return inner;

  return <div className="px-3 md:px-0 mb-3 max-w-[95%] sm:max-w-[90%] mx-auto">{inner}</div>;
}
