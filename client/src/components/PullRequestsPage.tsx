import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import {
  GitPullRequest,
  GitMerge,
  CheckCircle2,
  XCircle,
  Clock,
  AlertCircle,
  ExternalLink,
  ArrowLeft,
  RefreshCw,
  Loader2,
  MessageSquare,
  Wrench,
  Eye,
} from 'lucide-react';
import { Pencil, Check, X, Sparkles, SquareKanban, ChevronDown, ChevronRight } from 'lucide-react';
import { api } from '../utils/api';
import FileDiffView from './FileDiffView';
import { MarkdownContent } from './MarkdownRenderer';
import { RunRow } from './CiRunsSection';
import {
  relativePrTime,
  diffSummary,
  prStateBadge,
  summarizeChecks,
  checksBadge,
  summarizeReviews,
  reviewsBadge,
  mergeableBadge,
  reviewDecisionListBadge,
  mergePipelineListBadge,
  checkRowStyle,
  reviewStateColor,
  mergeButtonState,
  buildPrActivityTimeline,
} from '../utils/prFormatting';

// ─── Shared atoms ──────────────────────────────────────────────

function Badge({ label, color, bg, title }: any) {
  return (
    <span
      title={title || undefined}
      className={`inline-flex items-center px-2.5 py-1 rounded-full text-xs font-semibold ${bg} ${color}`}
    >
      {label}
    </span>
  );
}

const CHECK_ICONS = {
  success: CheckCircle2,
  failure: XCircle,
  pending: Clock,
  unknown: AlertCircle,
} as Record<string, any>;

// ─── List view ─────────────────────────────────────────────────

const STATE_TABS = [
  { key: 'open', label: 'Open' },
  { key: 'closed', label: 'Closed' },
  { key: 'all', label: 'All' },
];

function PrListItem({
  pr,
  onOpen,
  onResolveRow,
  onMergeRow,
  resolveAgentId,
  resolvingThisRow,
  mergingThisRow,
  bulkResolving,
  spawnedSessionId,
  onOpenSession,
}: any) {
  const state = prStateBadge(pr);
  const diff = diffSummary(pr);
  const showCi = Array.isArray(pr.check_rollup) && pr.check_rollup.length > 0;
  const ciBadge = showCi ? checksBadge(summarizeChecks(pr.check_rollup)) : null;
  const reviewB = reviewDecisionListBadge(pr.review_decision);
  const mBadge = mergeableBadge(pr.mergeable);
  const pipeB = mergePipelineListBadge(pr);
  const resolveBusy = bulkResolving || resolvingThisRow;
  const resolveDisabled = !resolveAgentId || resolveBusy;
  const mergeState = mergeButtonState(pr);
  const mergeBusy = bulkResolving || mergingThisRow;
  const mergeDisabled = !mergeState.enabled || mergeBusy;
  const mergeTitle = mergeBusy
    ? 'Merging…'
    : !pr.html_url
      ? 'No GitHub URL on this PR'
      : mergeState.reason;
  const resolveTitle = !resolveAgentId
    ? 'No agents configured'
    : bulkResolving
      ? 'Resolve all in progress…'
      : resolvingThisRow
        ? 'Resolving…'
        : 'Bring this PR into a session — resolve conflicts, tests, and review feedback, then auto-push';

  return (
    <div className="flex gap-2 w-full bg-gray-900 border border-gray-800 rounded-lg p-4 hover:border-gray-700 transition-colors items-stretch">
      <button
        type="button"
        onClick={onOpen}
        className="flex-1 min-w-0 text-left rounded-md focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/60"
      >
        <div className="flex items-center gap-2 mb-2">
          <Badge label={state.label} color={state.color} bg={state.bg} />
          <span className="text-xs font-medium text-gray-400">#{pr.number}</span>
          <span className="flex-1" />
          <span className="text-xs text-gray-500">{relativePrTime(pr.updated_at)}</span>
        </div>
        <div className="text-sm font-medium text-white line-clamp-2">{pr.title}</div>
        <div className="mt-1 text-xs text-gray-400 truncate">
          {pr.user ? `@${pr.user}` : ''}
          {pr.head ? ` · ${pr.head} → ${pr.base || 'main'}` : ''}
        </div>
        {pr.linked_card && (
          <div
            className="mt-1 flex items-center gap-1.5 text-xs text-sky-300/90"
            data-testid={`pr-linked-card-${pr.number}`}
          >
            <SquareKanban size={12} className="flex-shrink-0" />
            <span className="truncate">{pr.linked_card.title}</span>
          </div>
        )}
        {diff && <div className="mt-1 text-xs text-gray-400 tabular-nums">{diff}</div>}
        {(ciBadge || reviewB || mBadge.show || pipeB) && (
          <div className="mt-2 flex flex-wrap gap-1.5 items-center">
            {ciBadge && <Badge label={ciBadge.label} color={ciBadge.color} bg={ciBadge.bg} />}
            {reviewB && <Badge label={reviewB.label} color={reviewB.color} bg={reviewB.bg} />}
            {mBadge.show && (
              <Badge
                label={mBadge.label}
                color={mBadge.good ? 'text-emerald-400' : 'text-red-400'}
                bg={mBadge.good ? 'bg-emerald-500/10' : 'bg-red-500/10'}
              />
            )}
            {pipeB && (
              <Badge label={pipeB.label} color={pipeB.color} bg={pipeB.bg} title={pipeB.title} />
            )}
          </div>
        )}
        {Array.isArray(pr.labels) && pr.labels.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1">
            {pr.labels.slice(0, 4).map((l: any) => (
              <span
                key={l.name}
                className="px-1.5 py-0.5 text-[10px] text-gray-300 bg-gray-800 rounded"
              >
                {l.name}
              </span>
            ))}
          </div>
        )}
      </button>
      <div className="flex-shrink-0 self-center flex flex-row gap-2 items-stretch">
        <button
          type="button"
          onClick={(e: any) => {
            e.preventDefault();
            e.stopPropagation();
            onMergeRow(pr.number);
          }}
          disabled={mergeDisabled || !pr.html_url}
          title={mergeTitle}
          aria-label={`Merge PR #${pr.number}`}
          className="flex flex-col items-center justify-center gap-1 px-3 py-2 rounded-lg border border-emerald-800/80 bg-emerald-950/40 text-xs font-medium text-emerald-200 hover:bg-emerald-950/70 hover:text-white transition-colors disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-emerald-950/40 disabled:hover:text-emerald-200 min-w-[5.5rem]"
        >
          {mergingThisRow ? (
            <Loader2 size={16} className="animate-spin text-emerald-300" />
          ) : (
            <GitMerge size={16} className="text-emerald-300" />
          )}
          <span>Merge</span>
        </button>
        {spawnedSessionId ? (
          <div
            className="flex flex-col items-center justify-center gap-0.5 px-3 py-2 min-w-[5.5rem]"
            aria-label={`Session started for PR #${pr.number}`}
          >
            <CheckCircle2 size={20} className="text-emerald-400" aria-hidden />
            <span className="text-[10px] font-medium text-emerald-400/95 text-center leading-tight">
              Started
            </span>
            {typeof onOpenSession === 'function' && resolveAgentId && (
              <button
                type="button"
                onClick={(e: any) => {
                  e.preventDefault();
                  e.stopPropagation();
                  onOpenSession(resolveAgentId, spawnedSessionId);
                }}
                className="text-[10px] text-blue-400 hover:text-blue-300 hover:underline mt-0.5"
              >
                Open chat
              </button>
            )}
          </div>
        ) : (
          <button
            type="button"
            onClick={(e: any) => {
              e.preventDefault();
              e.stopPropagation();
              onResolveRow(pr.number);
            }}
            disabled={resolveDisabled}
            title={resolveTitle}
            aria-label={`Resolve PR #${pr.number}`}
            className="flex flex-col items-center justify-center gap-1 px-3 py-2 rounded-lg border border-gray-700 bg-gray-800/80 text-xs font-medium text-gray-200 hover:bg-gray-800 hover:text-white transition-colors disabled:opacity-50 disabled:cursor-not-allowed min-w-[5.5rem]"
          >
            {resolvingThisRow ? (
              <Loader2 size={16} className="animate-spin text-gray-400" />
            ) : (
              <Wrench size={16} className="text-gray-400" />
            )}
            <span>Resolve PR</span>
          </button>
        )}
      </div>
    </div>
  );
}

// ─── Detail view ───────────────────────────────────────────────

function SectionHeader({ children }: any) {
  return (
    <h3 className="text-xs font-semibold text-gray-300 uppercase tracking-wider mt-6 mb-2">
      {children}
    </h3>
  );
}

function CheckRow({ chk, onRerunJob = null }: any) {
  const style = checkRowStyle(chk);
  const Icon = CHECK_ICONS[style.iconKey] || AlertCircle;
  const label = (chk.conclusion || chk.status || '').toLowerCase();
  const clickable = !!chk.html_url;
  const RowTag = clickable ? 'a' : 'div';
  const rowProps = clickable
    ? { href: chk.html_url, target: '_blank', rel: 'noopener noreferrer' }
    : {};
  const rerunnable = typeof onRerunJob === 'function' && chk.job_id && chk.status === 'completed';
  return (
    <RowTag
      {...rowProps}
      className={`flex items-center gap-3 py-2 px-2 border-b border-gray-800 ${
        clickable ? 'hover:bg-gray-800/40 transition-colors' : ''
      }`}
    >
      <Icon size={16} className={`flex-shrink-0 ${style.color}`} />
      <span className="flex-1 text-sm text-white truncate">{chk.name || 'unnamed'}</span>
      <span className="text-xs text-gray-500">{label}</span>
      {rerunnable && (
        <button
          type="button"
          onClick={(e: any) => {
            e.preventDefault();
            e.stopPropagation();
            onRerunJob(chk.job_id);
          }}
          title={`Re-run ${chk.job_id}`}
          data-testid={`check-rerun-${chk.job_id}`}
          className="p-1 rounded text-gray-500 hover:text-gray-200 transition-colors flex-shrink-0"
        >
          <RefreshCw size={12} />
        </button>
      )}
    </RowTag>
  );
}

function ReviewBlock({ review }: any) {
  const state = (review.state || '').toUpperCase();
  const colorClass = reviewStateColor(review.state);
  return (
    <div className="bg-gray-900 border border-gray-800 rounded-lg p-3 mb-2">
      <div className="flex items-center gap-2 mb-1">
        <span className="text-sm font-medium text-gray-300">@{review.user || 'unknown'}</span>
        <span className={`text-xs font-semibold ${colorClass}`}>{state || 'REVIEW'}</span>
        <span className="ml-auto text-xs text-gray-500">{relativePrTime(review.submitted_at)}</span>
      </div>
      {review.body && (
        <p className="text-sm text-gray-300 whitespace-pre-wrap line-clamp-6">{review.body}</p>
      )}
    </div>
  );
}

function CommentBlock({ comment }: any) {
  return (
    <div className="bg-gray-900 border border-gray-800 rounded-lg p-3 mb-2">
      <div className="flex items-center gap-2 mb-1">
        <span className="text-sm font-medium text-gray-300">@{comment.user || 'unknown'}</span>
        <span className="ml-auto text-xs text-gray-500">{relativePrTime(comment.created_at)}</span>
      </div>
      {comment.body && (
        <p className="text-sm text-gray-300 whitespace-pre-wrap line-clamp-8">{comment.body}</p>
      )}
    </div>
  );
}

function ActivityKindIcon({ kind }: any) {
  const common = 'flex-shrink-0 mt-0.5';
  switch (kind) {
    case 'opened':
      return <GitPullRequest size={16} className={`${common} text-blue-400`} aria-hidden />;
    case 'merged':
      return <GitMerge size={16} className={`${common} text-purple-400`} aria-hidden />;
    case 'closed':
      return <XCircle size={16} className={`${common} text-red-400`} aria-hidden />;
    case 'review':
      return <Eye size={16} className={`${common} text-amber-400`} aria-hidden />;
    case 'comment':
      return <MessageSquare size={16} className={`${common} text-sky-400`} aria-hidden />;
    default:
      return <AlertCircle size={16} className={`${common} text-gray-500`} aria-hidden />;
  }
}

function ActivityTimelineRow({ item }: any) {
  const k = item.kind;
  const time =
    typeof item.at === 'string'
      ? relativePrTime(item.at)
      : item.atMs
        ? relativePrTime(new Date(item.atMs).toISOString())
        : '';

  if (k === 'opened') {
    const u = item.user ? `@${item.user}` : 'someone';
    return (
      <div className="min-w-0">
        <p className="text-sm text-gray-200">
          <span className="font-medium text-white">Opened</span> by {u}
          {time ? <span className="text-gray-500"> · {time}</span> : null}
        </p>
      </div>
    );
  }
  if (k === 'merged') {
    return (
      <p className="text-sm text-gray-200">
        <span className="font-medium text-white">Merged</span>
        {time ? <span className="text-gray-500"> · {time}</span> : null}
      </p>
    );
  }
  if (k === 'closed') {
    return (
      <p className="text-sm text-gray-200">
        <span className="font-medium text-white">Closed</span> without merging
        {time ? <span className="text-gray-500"> · {time}</span> : null}
      </p>
    );
  }
  if (k === 'review' && item.review) {
    return <ReviewBlock review={item.review} />;
  }
  if (k === 'comment' && item.comment) {
    return <CommentBlock comment={item.comment} />;
  }
  return null;
}

function PrActivityTimeline({ pr, detail }: any) {
  const activity = buildPrActivityTimeline(pr, detail);
  if (!activity.length) {
    return <p className="text-sm text-gray-500">No recorded activity for this pull request.</p>;
  }
  return (
    <ul className="space-y-4">
      {activity.map((item: any) => (
        <li key={item.id} className="flex gap-3">
          <ActivityKindIcon kind={item.kind} />
          <div className="flex-1 min-w-0">
            <ActivityTimelineRow item={item} />
          </div>
        </li>
      ))}
    </ul>
  );
}

/**
 * Lazy-loaded "Files changed" section — works for GitHub and Hub PRs.
 * For native PRs, inline review comments render in the diff and lines
 * are commentable (hover "+").
 */
function PrFilesChanged({
  prUrl,
  inlineComments = [],
  onAddComment = null,
  onDeleteComment = null,
}: any) {
  const [diff, setDiff] = useState<any>(null);
  const [error, setError] = useState<any>(null);

  useEffect(() => {
    setDiff(null);
    setError(null);
    if (!prUrl) return;
    try {
      api
        .getPrDiffText(prUrl)
        .then(setDiff)
        .catch((err: any) => setError(String(err?.message || err || 'Failed to load diff')));
    } catch (err: any) {
      setError(String(err?.message || err || 'Failed to load diff'));
    }
  }, [prUrl]);

  if (error) return <p className="text-sm text-red-400">{error}</p>;
  if (diff === null) {
    return (
      <p className="text-sm text-gray-500 flex items-center gap-2">
        <Loader2 size={14} className="animate-spin" /> Loading diff…
      </p>
    );
  }
  return (
    <FileDiffView
      patch={diff}
      emptyLabel="No file changes."
      comments={inlineComments}
      onAddComment={onAddComment}
      onDeleteComment={onDeleteComment}
    />
  );
}

function PrDetail({
  detail,
  onBack,
  onRefresh,
  refreshing,
  onResolve,
  resolving,
  onMerge,
  merging,
  agentId,
  spawnedSessionId,
  onOpenSession,
  projectId,
  onToast,
  onOpenCard,
}: any) {
  const pr = detail?.pr;
  const isNative = detail?.source === 'agenthub';
  const isOpen = (pr?.state || '').toLowerCase() === 'open';
  const isMerged = Boolean(pr?.merged_at);
  const editable = isNative && isOpen;
  const [editing, setEditing] = useState(false);
  const [editTitle, setEditTitle] = useState('');
  const [editBody, setEditBody] = useState('');
  const [saving, setSaving] = useState(false);
  const [closing, setClosing] = useState(false);
  const [reopening, setReopening] = useState(false);
  const [togglingReview, setTogglingReview] = useState(false);
  const [reviewVerdict, setReviewVerdict] = useState('approved');
  const [reviewBody, setReviewBody] = useState('');
  const [submittingReview, setSubmittingReview] = useState(false);
  if (!pr) return null;

  const toastErr = (err: any) => {
    if (onToast) onToast(String(err?.message || err || 'Request failed'), 'error', 6000);
  };

  const handleClose = async () => {
    setClosing(true);
    try {
      await api.closePr(pr.html_url);
      if (onToast) onToast(`PR #${pr.number} closed.`, 'success', 4000);
      onRefresh();
    } catch (err: any) {
      toastErr(err);
    } finally {
      setClosing(false);
    }
  };

  const handleReopen = async () => {
    setReopening(true);
    try {
      await api.reopenNativePr(projectId, pr.number);
      if (onToast) onToast(`PR #${pr.number} reopened.`, 'success', 4000);
      onRefresh();
    } catch (err: any) {
      toastErr(err);
    } finally {
      setReopening(false);
    }
  };

  const handleToggleReviewRequest = async () => {
    setTogglingReview(true);
    try {
      await api.requestNativePrReview(projectId, pr.number, !pr.review_requested);
      onRefresh();
    } catch (err: any) {
      toastErr(err);
    } finally {
      setTogglingReview(false);
    }
  };

  // Re-run the backing CI run (all jobs, or one) — GitHub's re-run UX.
  // `ci_run` only points at re-runnable push/pr-ci runs; `checks_run` is the
  // latest run for the head regardless of trigger (Finalize included) and
  // carries job rows so the expandable Run → Job → Step detail renders on the
  // PR page — not just the flat check list. Fall back to ci_run for older
  // server payloads that predate checks_run.
  const ciRun = detail?.ci_run ?? null;
  const displayRun = detail?.checks_run ?? ciRun;
  // Re-run / stop affordances stay gated to the re-runnable push/pr-ci run.
  // For a Finalize run (displayRun present, ci_run null) the detailed view
  // renders read-only — finalize re-runs go through the Finalize flow.
  const isRerunTarget = Boolean(ciRun && displayRun && ciRun.id === displayRun.id);
  const ciRerunnable = isNative && ciRun && ciRun.status !== 'queued' && ciRun.status !== 'running';
  const handleRerunChecks = async (jobId?: any) => {
    try {
      await api.rerunCiRun(projectId, ciRun.id, jobId);
      if (onToast) {
        onToast(jobId ? `Re-running ${jobId}…` : 'Re-running all checks…', 'success', 4000);
      }
      // Give the queued run a beat to appear, then refresh; the live
      // polling takes over once checks show as in progress.
      setTimeout(() => onRefresh(), 1500);
    } catch (err: any) {
      toastErr(err);
    }
  };

  const handleStopCiRun = async () => {
    if (!ciRun?.id) return;
    try {
      await api.cancelFinalizeRun(projectId, ciRun.id);
      if (onToast) onToast('Stopping all jobs…', 'success', 4000);
      setTimeout(() => onRefresh(), 1500);
    } catch (err: any) {
      toastErr(err);
    }
  };

  const handleSubmitReview = async () => {
    if (reviewVerdict === 'commented' && !reviewBody.trim()) return;
    setSubmittingReview(true);
    try {
      await api.submitNativePrReview(projectId, pr.number, {
        state: reviewVerdict,
        body: reviewBody,
      });
      setReviewBody('');
      if (onToast) onToast('Review submitted.', 'success', 4000);
      onRefresh();
    } catch (err: any) {
      toastErr(err);
    } finally {
      setSubmittingReview(false);
    }
  };

  const startEdit = () => {
    setEditTitle(pr.title || '');
    setEditBody(pr.body || '');
    setEditing(true);
  };

  const saveEdit = async () => {
    if (!editTitle.trim()) return;
    setSaving(true);
    try {
      await api.updateNativePr(projectId, pr.number, {
        title: editTitle.trim(),
        body: editBody,
      });
      setEditing(false);
      onRefresh();
    } catch (err: any) {
      if (onToast) onToast(String(err?.message || err || 'Failed to save'), 'error');
    } finally {
      setSaving(false);
    }
  };

  const state = prStateBadge(pr);
  const checksSummary = summarizeChecks(detail.checks);
  const cBadge = checksBadge(checksSummary);
  const reviewState = summarizeReviews(detail.reviews);
  const rBadge = reviewsBadge(reviewState);
  const mBadge = mergeableBadge(pr.mergeable);

  const resolveDisabled = resolving || !agentId;
  const resolveTitle = !agentId
    ? 'No agents configured'
    : resolving
      ? 'Resolving…'
      : 'Bring this PR into a session — resolve conflicts, tests, and review feedback, then auto-push';

  const mergeState = mergeButtonState(pr);
  const mergeDisabled = merging || !mergeState.enabled || !pr.html_url;
  const mergeTitle = merging
    ? 'Merging…'
    : !pr.html_url
      ? 'No PR URL available'
      : mergeState.reason;

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="w-full p-4 md:p-6">
        <div className="flex items-center gap-3 mb-4">
          <button
            type="button"
            onClick={onBack}
            className="flex items-center gap-1.5 text-sm text-blue-400 hover:text-blue-300 transition-colors"
          >
            <ArrowLeft size={16} />
            Back to list
          </button>
          <span className="flex-1" />
          {spawnedSessionId ? (
            <div className="flex items-center gap-2 text-sm text-emerald-400/95">
              <CheckCircle2 size={16} className="flex-shrink-0" aria-hidden />
              <span>Session started</span>
              {typeof onOpenSession === 'function' && agentId && (
                <button
                  type="button"
                  onClick={() => onOpenSession(agentId, spawnedSessionId)}
                  className="text-blue-400 hover:text-blue-300 hover:underline"
                >
                  Open chat
                </button>
              )}
            </div>
          ) : (
            <button
              type="button"
              onClick={onResolve}
              disabled={resolveDisabled}
              title={resolveTitle}
              className="flex items-center gap-1.5 text-sm text-gray-400 hover:text-gray-200 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {resolving ? <Loader2 size={14} className="animate-spin" /> : <Wrench size={14} />}
              Resolve PR
            </button>
          )}
          {isNative && isOpen && (
            <button
              type="button"
              onClick={handleToggleReviewRequest}
              disabled={togglingReview}
              title={
                pr.review_requested
                  ? 'Clear the review-request flag'
                  : 'Request a review — dispatches the project Reviewer agent against this PR'
              }
              data-testid="pr-request-review-button"
              className="flex items-center gap-1.5 text-sm text-amber-300 hover:text-amber-100 transition-colors disabled:opacity-50"
            >
              {togglingReview ? <Loader2 size={14} className="animate-spin" /> : <Eye size={14} />}
              {pr.review_requested ? 'Review requested' : 'Request review'}
            </button>
          )}
          {isOpen && (
            <button
              type="button"
              onClick={handleClose}
              disabled={closing || !pr.html_url}
              title="Close this PR without merging"
              data-testid="pr-close-button"
              className="flex items-center gap-1.5 text-sm text-red-300 hover:text-red-100 transition-colors disabled:opacity-50"
            >
              {closing ? <Loader2 size={14} className="animate-spin" /> : <XCircle size={14} />}
              Close
            </button>
          )}
          {isNative && !isOpen && !isMerged && (
            <button
              type="button"
              onClick={handleReopen}
              disabled={reopening}
              title="Reopen this PR"
              data-testid="pr-reopen-button"
              className="flex items-center gap-1.5 text-sm text-emerald-300 hover:text-emerald-100 transition-colors disabled:opacity-50"
            >
              {reopening ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
              Reopen
            </button>
          )}
          {isOpen && (
            <button
              type="button"
              onClick={onMerge}
              disabled={mergeDisabled}
              title={mergeTitle}
              aria-label={`Merge PR #${pr.number}`}
              className="flex items-center gap-1.5 text-sm text-emerald-300 hover:text-emerald-100 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {merging ? (
                <Loader2 size={14} className="animate-spin text-emerald-300" />
              ) : (
                <GitMerge size={14} className="text-emerald-300" />
              )}
              Merge
            </button>
          )}
          <button
            type="button"
            onClick={onRefresh}
            disabled={refreshing}
            className="flex items-center gap-1.5 text-sm text-gray-400 hover:text-gray-200 transition-colors disabled:opacity-50"
          >
            <RefreshCw size={14} className={refreshing ? 'animate-spin' : ''} />
            Refresh
          </button>
        </div>

        <div className="flex items-center gap-2 mb-2">
          <Badge label={state.label} color={state.color} bg={state.bg} />
          <span className="text-xs font-medium text-gray-400">#{pr.number}</span>
          {editable && !editing && (
            <button
              type="button"
              onClick={startEdit}
              title="Edit title and description"
              data-testid="pr-edit-button"
              className="ml-1 p-1 rounded text-gray-500 hover:text-gray-200 transition-colors"
            >
              <Pencil size={13} />
            </button>
          )}
        </div>
        {editing ? (
          <div className="space-y-2 mb-2" data-testid="pr-edit-form">
            <input
              value={editTitle}
              onChange={(e: any) => setEditTitle(e.target.value)}
              className="w-full bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-lg font-semibold text-white focus:outline-none focus:border-gray-600"
              placeholder="PR title"
            />
            <textarea
              value={editBody}
              onChange={(e: any) => setEditBody(e.target.value)}
              rows={10}
              className="w-full bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-200 font-mono focus:outline-none focus:border-gray-600"
              placeholder="Description (markdown)"
            />
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={saveEdit}
                disabled={saving || !editTitle.trim()}
                data-testid="pr-edit-save"
                className="flex items-center gap-1.5 text-sm bg-emerald-600 hover:bg-emerald-500 disabled:bg-gray-700 disabled:text-gray-500 text-white px-3 py-1.5 rounded-lg transition-colors"
              >
                {saving ? <Loader2 size={13} className="animate-spin" /> : <Check size={13} />}
                Save
              </button>
              <button
                type="button"
                onClick={() => setEditing(false)}
                className="flex items-center gap-1.5 text-sm text-gray-400 hover:text-gray-200 px-3 py-1.5 transition-colors"
              >
                <X size={13} />
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <h2 className="text-xl font-semibold text-white mb-2">{pr.title}</h2>
        )}

        <div className="text-xs text-gray-400">
          {pr.user ? `@${pr.user}` : 'unknown'}
          {pr.created_at ? ` opened ${relativePrTime(pr.created_at)}` : ''}
        </div>
        {pr.head && (
          <div className="text-xs text-gray-400 mt-0.5">
            <code className="bg-gray-800/60 px-1 rounded">{pr.head}</code> →{' '}
            <code className="bg-gray-800/60 px-1 rounded">{pr.base || 'main'}</code>
          </div>
        )}
        <div className="text-xs text-gray-400 tabular-nums mt-1">{diffSummary(pr)}</div>
        {pr.linked_card && (
          <button
            type="button"
            onClick={() => onOpenCard && onOpenCard(pr.linked_card.id)}
            disabled={typeof onOpenCard !== 'function'}
            title="Open the kanban board"
            data-testid="pr-detail-linked-card"
            className="mt-2 inline-flex items-center gap-1.5 text-xs text-sky-300 hover:text-sky-100 bg-sky-500/10 hover:bg-sky-500/20 px-2 py-1 rounded-lg transition-colors disabled:cursor-default disabled:hover:bg-sky-500/10"
          >
            <SquareKanban size={12} />
            <span className="truncate max-w-[28rem]">{pr.linked_card.title}</span>
          </button>
        )}

        {Array.isArray(pr.labels) && pr.labels.length > 0 && (
          <div className="mt-3 flex flex-wrap gap-1">
            {pr.labels.map((l: any) => (
              <span
                key={l.name}
                className="px-1.5 py-0.5 text-[10px] text-gray-300 bg-gray-800 rounded"
              >
                {l.name}
              </span>
            ))}
          </div>
        )}

        {/* External link only for real GitHub URLs — native PR URLs are
            in-app client routes with nothing external to open. */}
        {pr.html_url && /^https?:\/\//i.test(pr.html_url) && (
          <a
            href={pr.html_url}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 mt-4 text-sm text-blue-400 hover:text-blue-300 bg-gray-800/50 hover:bg-gray-800 px-3 py-1.5 rounded-lg transition-colors"
          >
            <ExternalLink size={14} />
            Open on GitHub
          </a>
        )}

        {!editing && pr.body && (
          <>
            <SectionHeader>Description</SectionHeader>
            <div
              className="markdown-content text-sm text-gray-300 break-words bg-gray-900/40 border border-gray-800 rounded-lg p-3"
              data-testid="pr-description"
            >
              <MarkdownContent content={pr.body} />
            </div>
          </>
        )}

        {/* Summary strip: checks + reviews + mergeable */}
        <div className="flex flex-wrap gap-2 mt-5">
          {pr.finalize_validated && (
            <Badge
              label="✓ Validated by Finalize"
              color="text-emerald-300"
              bg="bg-emerald-500/15"
              title="This exact commit already passed review and CI checks in its Finalize run — PR-level CI is skipped."
            />
          )}
          <Badge label={cBadge.label} color={cBadge.color} bg={cBadge.bg} />
          <Badge label={rBadge.label} color={rBadge.color} bg={rBadge.bg} />
          {mBadge.show && (
            <Badge
              label={mBadge.label}
              color={mBadge.good ? 'text-emerald-400' : 'text-red-400'}
              bg={mBadge.good ? 'bg-emerald-500/10' : 'bg-red-500/10'}
            />
          )}
        </div>

        {isNative && (
          <>
            <SectionHeader>Reviews</SectionHeader>
            {pr.review_requested && (
              <p className="text-xs text-amber-300 mb-2" data-testid="pr-review-requested-hint">
                Review requested{pr.review_requested_by ? ` by ${pr.review_requested_by}` : ''} —
                awaiting a verdict.
              </p>
            )}
            {(!detail.reviews || detail.reviews.length === 0) && (
              <p className="text-sm text-gray-500 mb-2">No reviews yet.</p>
            )}
            {Array.isArray(detail.reviews) && detail.reviews.length > 0 && (
              <div className="space-y-2 mb-3" data-testid="pr-reviews-list">
                {detail.reviews.map((r: any) => (
                  <div key={r.id} className="bg-gray-900/40 border border-gray-800 rounded-lg p-3">
                    <div className="flex items-center gap-2 text-xs">
                      <span className="text-gray-300 font-medium">@{r.user || 'unknown'}</span>
                      <span className={reviewStateColor(r.state)}>
                        {String(r.state || '')
                          .toLowerCase()
                          .replace('_', ' ')}
                      </span>
                      <span className="ml-auto text-gray-600">
                        {relativePrTime(r.submitted_at)}
                      </span>
                    </div>
                    {r.body && (
                      <pre className="text-sm text-gray-300 whitespace-pre-wrap font-sans mt-1.5">
                        {r.body}
                      </pre>
                    )}
                  </div>
                ))}
              </div>
            )}

            {/* Autofix — hand the PR (incl. review feedback) to an agent. */}
            {isOpen && (
              <button
                type="button"
                onClick={onResolve}
                disabled={resolveDisabled}
                title={
                  resolveTitle === 'Resolving…'
                    ? resolveTitle
                    : 'Spawn a session to address the review feedback, conflicts, or failing checks, then auto-push the fix to this PR'
                }
                data-testid="pr-autofix-button"
                className="flex items-center gap-1.5 text-sm bg-gray-800 hover:bg-gray-700 text-gray-200 px-3 py-1.5 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed mb-3"
              >
                {resolving ? <Loader2 size={14} className="animate-spin" /> : <Wrench size={14} />}
                Autofix from review
              </button>
            )}

            {/* Review composer */}
            {isOpen && (
              <div
                className="bg-gray-900/40 border border-gray-800 rounded-lg p-3 space-y-2"
                data-testid="pr-review-composer"
              >
                <div className="flex items-center gap-2">
                  <select
                    value={reviewVerdict}
                    onChange={(e: any) => setReviewVerdict(e.target.value)}
                    className="bg-gray-900 border border-gray-700 rounded-lg px-2 py-1.5 text-sm text-gray-200 focus:outline-none focus:border-gray-600"
                    data-testid="pr-review-verdict"
                  >
                    <option value="approved">Approve</option>
                    <option value="changes_requested">Request changes</option>
                    <option value="commented">Comment</option>
                  </select>
                  <button
                    type="button"
                    onClick={handleSubmitReview}
                    disabled={
                      submittingReview || (reviewVerdict === 'commented' && !reviewBody.trim())
                    }
                    data-testid="pr-review-submit"
                    className="flex items-center gap-1.5 text-sm bg-emerald-600 hover:bg-emerald-500 disabled:bg-gray-700 disabled:text-gray-500 text-white px-3 py-1.5 rounded-lg transition-colors"
                  >
                    {submittingReview ? (
                      <Loader2 size={13} className="animate-spin" />
                    ) : (
                      <CheckCircle2 size={13} />
                    )}
                    Submit review
                  </button>
                </div>
                <textarea
                  value={reviewBody}
                  onChange={(e: any) => setReviewBody(e.target.value)}
                  rows={3}
                  placeholder="Review notes (required for comments, optional otherwise)…"
                  className="w-full bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-200 focus:outline-none focus:border-gray-600"
                />
              </div>
            )}
          </>
        )}

        <SectionHeader>Activity</SectionHeader>
        <p className="text-xs text-gray-500 mb-3">
          Chronological history{isNative ? '' : ' from GitHub'} (open/merge/close, reviews, and
          comments).
        </p>
        <PrActivityTimeline pr={pr} detail={detail} />

        {/* CI Checks */}
        <div className="flex items-center gap-3">
          <SectionHeader>CI Checks</SectionHeader>
          {ciRerunnable && (
            <button
              type="button"
              onClick={() => handleRerunChecks()}
              title="Re-run all checks against this commit"
              data-testid="pr-rerun-checks"
              className="mt-6 flex items-center gap-1.5 text-xs text-gray-400 hover:text-gray-200 transition-colors"
            >
              <RefreshCw size={12} />
              Re-run all checks
            </button>
          )}
        </div>
        {displayRun && (
          <div className="space-y-1.5" data-testid="pr-ci-run-row">
            <RunRow
              projectId={projectId}
              run={displayRun}
              onRerun={isRerunTarget && ciRerunnable ? () => handleRerunChecks() : null}
              onStop={isRerunTarget ? handleStopCiRun : null}
            />
          </div>
        )}
        {!displayRun && (!detail.checks || detail.checks.length === 0) && (
          <p className="text-sm text-gray-500" data-testid="pr-checks-empty-note">
            {detail.checks_note || 'No checks reported.'}
          </p>
        )}
        {!displayRun && Array.isArray(detail.checks) && detail.checks.length > 0 && (
          <div className="bg-gray-900/40 border border-gray-800 rounded-lg overflow-hidden">
            {detail.checks.map((chk: any, i: any) => (
              <CheckRow
                key={chk.id || chk.name || i}
                chk={chk}
                onRerunJob={ciRerunnable ? (jobId: any) => handleRerunChecks(jobId) : null}
              />
            ))}
          </div>
        )}

        {/* Commits — deliberately LAST and collapsed by default: long
            session branches accumulate dozens of commits that would
            otherwise dominate the page. */}
        {Array.isArray(detail.commits) && detail.commits.length > 0 && (
          <PrCommitsSection commits={detail.commits} />
        )}

        {/* Files changed — last on the page: diffs can be very long and each
            file section starts collapsed so review/activity/checks stay in
            view without scrolling past a wall of patch text. */}
        <SectionHeader>Files changed</SectionHeader>
        <PrFilesChanged
          prUrl={pr.html_url}
          inlineComments={isNative ? (detail.inline_comments ?? []) : []}
          onAddComment={
            editable
              ? async ({ filePath, line, side, body }: any) => {
                  try {
                    await api.addNativePrComment(projectId, pr.number, {
                      filePath,
                      line,
                      side,
                      body,
                    });
                    onRefresh();
                  } catch (err: any) {
                    toastErr(err);
                  }
                }
              : null
          }
          onDeleteComment={
            editable
              ? async (comment: any) => {
                  try {
                    await api.deleteNativePrComment(projectId, pr.number, comment.id);
                    onRefresh();
                  } catch (err: any) {
                    toastErr(err);
                  }
                }
              : null
          }
        />

        <div className="h-10" />
      </div>
    </div>
  );
}

/** Collapsed-by-default commit list for the PR detail tail. */
function PrCommitsSection({ commits }: any) {
  const [open, setOpen] = useState(false);
  return (
    <div className="mt-6" data-testid="pr-commits-section">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        data-testid="pr-commits-toggle"
        className="flex items-center gap-2 text-xs font-semibold text-gray-400 uppercase tracking-wider hover:text-gray-200 transition-colors"
      >
        {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        Commits ({commits.length})
      </button>
      {open && (
        <div className="mt-2 bg-gray-900/40 border border-gray-800 rounded-lg divide-y divide-gray-800 overflow-hidden">
          {commits.map((c: any) => (
            <div key={c.sha} className="flex items-center gap-3 px-3 py-2 text-sm">
              <code className="text-[11px] text-gray-500 font-mono flex-shrink-0">
                {String(c.sha || '').slice(0, 8)}
              </code>
              <span className="text-gray-200 truncate flex-1" title={c.subject}>
                {c.subject}
              </span>
              <span className="text-xs text-gray-500 flex-shrink-0">{c.author}</span>
              <span className="text-xs text-gray-600 flex-shrink-0">{relativePrTime(c.date)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** Default PR title from a branch name: last segment, separators → spaces. */
function titleFromBranch(branch: any) {
  const last = (
    String(branch || '')
      .split('/')
      .pop() ?? ''
  )
    .replace(/[-_]+/g, ' ')
    .trim();
  return last ? last.charAt(0).toUpperCase() + last.slice(1) : branch;
}

function isAgentHubManagedSessionBranch(branch: any) {
  return /^agent-hub\/[^/]+\/session-[^/]+$/.test(String(branch || ''));
}

function prHeadBranch(pr: any) {
  return typeof pr?.head === 'string' ? pr.head : null;
}

const BRANCH_CHANGE_SCAN_CONCURRENCY = 4;

export async function mapWithConcurrency(items: any, limit: any, mapper: any) {
  const capped = Math.max(1, Math.min(limit, items.length));
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: capped }, async () => {
      while (next < items.length) {
        const index = next;
        next += 1;
        results[index] = await mapper(items[index], index);
      }
    }),
  );
  return results;
}

function BranchChangesPreview({ projectId, branch, enabled = true }: any) {
  const [state, setState] = useState<any>({ loading: false, data: null, error: null });

  useEffect(() => {
    let alive = true;
    if (!enabled || !projectId || !branch) {
      setState({ loading: false, data: null, error: null });
      return () => {
        alive = false;
      };
    }
    setState({ loading: true, data: null, error: null });
    api
      .getNativePrBranchChanges(projectId, branch)
      .then((data: any) => {
        if (alive) setState({ loading: false, data, error: null });
      })
      .catch((err: any) => {
        if (alive) {
          setState({
            loading: false,
            data: null,
            error: String(err?.message || err || 'Failed to load file changes'),
          });
        }
      });
    return () => {
      alive = false;
    };
  }, [projectId, branch, enabled]);

  if (!enabled || !branch) return null;

  const stats = state.data?.stats;
  const files = Array.isArray(state.data?.files) ? state.data.files : [];

  return (
    <div
      className="border border-gray-800 bg-gray-950/70 rounded-lg overflow-hidden"
      data-testid={`branch-changes-${branch}`}
    >
      <div className="px-3 py-2 border-b border-gray-800 flex items-center gap-2">
        <span className="text-xs font-semibold text-gray-300">File changes</span>
        <span className="flex-1" />
        {state.loading && <Loader2 size={13} className="animate-spin text-gray-500" />}
        {stats && (
          <span className="text-xs text-gray-500">
            {stats.changedFiles} file{stats.changedFiles === 1 ? '' : 's'}
            <span className="text-emerald-400 ml-2">+{stats.additions}</span>
            <span className="text-red-400 ml-1">-{stats.deletions}</span>
          </span>
        )}
      </div>
      {state.error ? (
        <div className="px-3 py-2 text-xs text-amber-300">{state.error}</div>
      ) : state.loading ? (
        <div className="px-3 py-2 text-xs text-gray-500">Loading file changes...</div>
      ) : files.length === 0 ? (
        <div className="px-3 py-2 text-xs text-gray-500">No file changes against base.</div>
      ) : (
        <div className="max-h-48 overflow-y-auto divide-y divide-gray-900">
          {files.map((file: any) => (
            <div key={file.filename} className="px-3 py-2 flex items-center gap-3 text-xs">
              <span className="w-16 shrink-0 uppercase text-[10px] text-gray-500">
                {file.status}
              </span>
              <span
                className="min-w-0 flex-1 truncate font-mono text-gray-300"
                title={file.filename}
              >
                {file.filename}
              </span>
              <span className="shrink-0 text-emerald-400">+{file.additions}</span>
              <span className="shrink-0 text-red-400">-{file.deletions}</span>
            </div>
          ))}
          {state.data?.truncated && (
            <div className="px-3 py-2 text-xs text-gray-500">Showing first 100 files.</div>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * GitHub-style "Compare & pull request" banner for a recently pushed
 * branch with no open PR. Expands into an inline create form.
 */
function RecentPushBanner({ push, onCreate, projectId }: any) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState(() => titleFromBranch(push.branch));
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<any>(null);

  const submit = async () => {
    if (!title.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      await onCreate(push.branch, { title: title.trim(), body });
    } catch (err: any) {
      setError(String(err?.message || err || 'Failed to create PR'));
    } finally {
      setBusy(false);
    }
  };

  // Optional AI assist — fills the fields, which stay fully editable.
  const generate = async () => {
    if (generating) return;
    setGenerating(true);
    setError(null);
    try {
      const r = await api.generatePrDescription(projectId, push.branch);
      if (r?.title) setTitle(r.title);
      if (typeof r?.body === 'string') setBody(r.body);
    } catch (err: any) {
      setError(String(err?.message || err || 'Generation failed'));
    } finally {
      setGenerating(false);
    }
  };

  return (
    <div
      className="bg-amber-950/20 border border-amber-700/40 rounded-lg p-3 mb-2"
      data-testid={`recent-push-${push.branch}`}
    >
      <div className="flex items-center gap-2 flex-wrap">
        <GitPullRequest size={14} className="text-amber-400 flex-shrink-0" />
        <code className="text-xs text-amber-200 bg-gray-900/60 px-1.5 py-0.5 rounded">
          {push.branch}
        </code>
        <span className="text-xs text-amber-200/80">
          had a recent push {relativePrTime(new Date(push.pushedAt).toISOString())}
        </span>
        <span className="flex-1" />
        <button
          type="button"
          onClick={() => setOpen(!open)}
          data-testid={`recent-push-create-${push.branch}`}
          className="text-xs bg-emerald-600 hover:bg-emerald-500 text-white px-3 py-1.5 rounded-lg transition-colors"
        >
          {open ? 'Cancel' : 'Create pull request'}
        </button>
      </div>
      {open && (
        <div className="mt-3 space-y-2" data-testid={`recent-push-form-${push.branch}`}>
          <input
            value={title}
            onChange={(e: any) => setTitle(e.target.value)}
            placeholder="PR title"
            className="w-full bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-gray-600"
          />
          <textarea
            value={body}
            onChange={(e: any) => setBody(e.target.value)}
            rows={10}
            placeholder={'## Summary\n…\n\n## Test plan\n…'}
            className="w-full bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-200 font-mono focus:outline-none focus:border-gray-600"
          />
          <BranchChangesPreview projectId={projectId} branch={push.branch} enabled={open} />
          {error && <p className="text-xs text-red-400">{error}</p>}
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={submit}
              disabled={busy || !title.trim()}
              data-testid={`recent-push-submit-${push.branch}`}
              className="flex items-center gap-1.5 text-sm bg-emerald-600 hover:bg-emerald-500 disabled:bg-gray-700 disabled:text-gray-500 text-white px-3 py-1.5 rounded-lg transition-colors"
            >
              {busy ? <Loader2 size={13} className="animate-spin" /> : <GitPullRequest size={13} />}
              Create pull request
            </button>
            <button
              type="button"
              onClick={generate}
              disabled={generating || busy}
              title="Generate a title and description from the branch diff (you can still edit them)"
              data-testid={`recent-push-generate-${push.branch}`}
              className="flex items-center gap-1.5 text-sm text-purple-300 hover:text-purple-100 border border-purple-700/40 bg-purple-950/20 hover:bg-purple-950/40 px-3 py-1.5 rounded-lg transition-colors disabled:opacity-50"
            >
              {generating ? <Loader2 size={13} className="animate-spin" /> : <Sparkles size={13} />}
              {generating ? 'Generating…' : 'Generate with AI'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * GitHub-style "New pull request" for any existing branch: pick a head
 * branch, optionally AI-generate the text, create. Base is the default
 * branch (matching the create endpoint's default).
 */
function NewPrPanel({ projectId, onCreate, onClose, excludedBranches = new Set() }: any) {
  const [branchData, setBranchData] = useState<any>(null);
  const [branch, setBranch] = useState('');
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<any>(null);
  const [candidateChanges, setCandidateChanges] = useState<Record<string, any>>({});

  useEffect(() => {
    let alive = true;
    api
      .getGitHostBranches(projectId)
      .then((d: any) => alive && setBranchData(d))
      .catch(() => alive && setBranchData({ defaultBranch: null, branches: [] }));
    return () => {
      alive = false;
    };
  }, [projectId]);

  const branchesLoaded = branchData !== null;
  const defaultBranch = branchData?.defaultBranch || 'main';
  const rawCandidates = useMemo(
    () =>
      (branchData?.branches || [])
        .map((b: any) => b.name)
        .filter(
          (name: any) =>
            name !== defaultBranch &&
            !isAgentHubManagedSessionBranch(name) &&
            !excludedBranches.has(name),
        ),
    [branchData, defaultBranch, excludedBranches],
  );
  // Stable content key for the candidate set. The branch-scan effect below keys off
  // this string, not the `rawCandidates` array identity — otherwise any parent
  // re-render (soft refresh, WS event) that hands down a fresh `excludedBranches`
  // Set would churn `rawCandidates` and re-trigger the whole scan, resetting every
  // entry to `{loading:true}` and re-hammering the server (AH-1251).
  const rawCandidatesKey = useMemo(() => rawCandidates.join('\n'), [rawCandidates]);
  const rawCandidatesRef = useRef<any[]>(rawCandidates);
  rawCandidatesRef.current = rawCandidates;
  const candidates = rawCandidates.filter((name: any) => candidateChanges[name]?.hasChanges);
  const candidateScanDone =
    branchData !== null &&
    rawCandidates.every((name: any) => {
      const result = candidateChanges[name];
      return result && ('hasChanges' in result || result.scanError);
    });
  const candidateScanFailed =
    branchData !== null && rawCandidates.some((name: any) => candidateChanges[name]?.scanError);

  useEffect(() => {
    let alive = true;
    if (branchData === null) return () => {};
    const names = rawCandidatesRef.current;
    if (names.length === 0) {
      setCandidateChanges({});
      return () => {
        alive = false;
      };
    }
    setCandidateChanges(Object.fromEntries(names.map((name: any) => [name, { loading: true }])));
    mapWithConcurrency(names, BRANCH_CHANGE_SCAN_CONCURRENCY, async (name: any) => {
      try {
        const changes = await api.getNativePrBranchChanges(projectId, name);
        return [name, { hasChanges: Number(changes?.stats?.changedFiles || 0) > 0 }];
      } catch {
        return [name, { hasChanges: true, scanError: true }];
      }
    }).then((entries: any) => {
      if (alive) setCandidateChanges(Object.fromEntries(entries));
    });
    return () => {
      alive = false;
    };
    // Keyed on the candidate content (rawCandidatesKey), not the array identity,
    // so the scan only re-runs when the actual branch set changes, not on every
    // reference-churning parent re-render (AH-1251). Candidate names are read from
    // rawCandidatesRef so the effect body never closes over a stale array.
  }, [projectId, branchData, rawCandidatesKey]);

  useEffect(() => {
    if (branch && candidateChanges[branch]?.hasChanges === false) {
      setBranch('');
    }
  }, [branch, candidateChanges]);

  const pick = (name: any) => {
    setBranch(name);
    if (!title.trim()) setTitle(titleFromBranch(name));
  };

  const submit = async () => {
    if (!branch || !title.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      await onCreate(branch, { title: title.trim(), body });
      onClose();
    } catch (err: any) {
      setError(String(err?.message || err || 'Failed to create PR'));
    } finally {
      setBusy(false);
    }
  };

  const generate = async () => {
    if (!branch || generating) return;
    setGenerating(true);
    setError(null);
    try {
      const r = await api.generatePrDescription(projectId, branch);
      if (r?.title) setTitle(r.title);
      if (typeof r?.body === 'string') setBody(r.body);
    } catch (err: any) {
      setError(String(err?.message || err || 'Generation failed'));
    } finally {
      setGenerating(false);
    }
  };

  return (
    <div
      className="bg-gray-900 border border-gray-700 rounded-lg p-4 mb-4 space-y-2"
      data-testid="new-pr-panel"
    >
      <div className="flex items-center gap-2">
        <GitPullRequest size={15} className="text-gray-400" />
        <span className="text-sm font-medium text-white">New pull request</span>
        <span className="flex-1" />
        <button
          type="button"
          onClick={onClose}
          className="text-gray-500 hover:text-gray-300 transition-colors"
          aria-label="Close new pull request panel"
        >
          <X size={14} />
        </button>
      </div>
      <div className="flex items-center gap-2 text-sm">
        <select
          value={branch}
          onChange={(e: any) => pick(e.target.value)}
          data-testid="new-pr-branch"
          className="bg-gray-950 border border-gray-700 rounded-lg px-2 py-1.5 text-sm text-gray-200 focus:outline-none focus:border-gray-600 max-w-[50%]"
        >
          <option value="">
            {branchData === null || !candidateScanDone ? 'Loading branches…' : 'Select a branch…'}
          </option>
          {candidates.map((name: any) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </select>
        <span className="text-gray-500">→</span>
        <code
          className="text-xs bg-gray-800/60 px-1.5 py-0.5 rounded text-gray-300"
          data-testid="new-pr-base-branch"
        >
          {branchesLoaded ? defaultBranch : '…'}
        </code>
      </div>
      {branchData !== null && candidateScanDone && candidates.length === 0 && (
        <p className="text-xs text-gray-500">
          No branches with file changes against {defaultBranch}.
        </p>
      )}
      {candidateScanDone && candidateScanFailed && (
        <p className="text-xs text-amber-300">
          Some branches could not be prechecked, so they remain selectable.
        </p>
      )}
      <input
        value={title}
        onChange={(e: any) => setTitle(e.target.value)}
        placeholder="PR title"
        className="w-full bg-gray-950 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-gray-600"
      />
      <textarea
        value={body}
        onChange={(e: any) => setBody(e.target.value)}
        rows={10}
        placeholder={'## Summary\n…\n\n## Test plan\n…'}
        className="w-full bg-gray-950 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-200 font-mono focus:outline-none focus:border-gray-600"
      />
      <BranchChangesPreview projectId={projectId} branch={branch} enabled={!!branch} />
      {error && <p className="text-xs text-red-400">{error}</p>}
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={submit}
          disabled={busy || !branch || !title.trim()}
          data-testid="new-pr-submit"
          className="flex items-center gap-1.5 text-sm bg-emerald-600 hover:bg-emerald-500 disabled:bg-gray-700 disabled:text-gray-500 text-white px-3 py-1.5 rounded-lg transition-colors"
        >
          {busy ? <Loader2 size={13} className="animate-spin" /> : <GitPullRequest size={13} />}
          Create pull request
        </button>
        <button
          type="button"
          onClick={generate}
          disabled={generating || busy || !branch}
          title="Generate a title and description from the branch diff (you can still edit them)"
          data-testid="new-pr-generate"
          className="flex items-center gap-1.5 text-sm text-purple-300 hover:text-purple-100 border border-purple-700/40 bg-purple-950/20 hover:bg-purple-950/40 px-3 py-1.5 rounded-lg transition-colors disabled:opacity-50"
        >
          {generating ? <Loader2 size={13} className="animate-spin" /> : <Sparkles size={13} />}
          {generating ? 'Generating…' : 'Generate with AI'}
        </button>
      </div>
    </div>
  );
}

// ─── Main page ─────────────────────────────────────────────────

export default function PullRequestsPage({
  projectId,
  project,
  onOpenSession,
  onToast,
  /** Navigate to the kanban board (linked-card chip). */
  onOpenCard = null,
  /** Bumped from App when GitHub/kanban activity should re-sync the open PR list. */
  listRefreshNonce = 0,
  /** When set, opens this PR's detail view on mount (e.g. from session summary). */
  initialPrNumber = null,
}: any) {
  const [state, setState] = useState('open');
  const [pulls, setPulls] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<any>(null);
  const [refreshing, setRefreshing] = useState(false);

  const [selectedNumber, setSelectedNumber] = useState<any>(null);
  const [detail, setDetail] = useState<any>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<any>(null);
  const [resolving, setResolving] = useState(false);
  const [resolvingFromList, setResolvingFromList] = useState<any>(null);
  const [mergingDetail, setMergingDetail] = useState(false);
  const [mergingFromList, setMergingFromList] = useState<any>(null);
  const [bulkResolving, setBulkResolving] = useState(false);
  /** PR numbers for which a resolve run spawned a session (inline checkmark; no auto navigation). */
  const [sessionSpawnedByPr, setSessionSpawnedByPr] = useState<Record<string, any>>(() => ({}));

  const resolveAgentId =
    Array.isArray(project?.agents) && project.agents.length > 0
      ? typeof project.agents[0] === 'string'
        ? project.agents[0]
        : project.agents[0]?.id
      : null;

  /** Monotonic counter so an older in-flight list fetch cannot clobber newer results (Strict Mode / rapid tab switches). */
  const listFetchGenRef = useRef(0);
  const detailFetchGenRef = useRef(0);

  const loadList = useCallback(
    async ({ soft = false }: any = {}) => {
      if (!projectId) {
        setError('No project selected.');
        setLoading(false);
        setRefreshing(false);
        return;
      }
      const gen = ++listFetchGenRef.current;
      setError(null);
      if (soft) setRefreshing(true);
      else setLoading(true);
      try {
        const data = await api.getProjectPulls(projectId, { state, limit: 50 });
        if (gen !== listFetchGenRef.current) return;
        setPulls(data.pulls || []);
      } catch (err: any) {
        if (gen !== listFetchGenRef.current) return;
        console.warn('Failed to load PRs:', err?.message || err);
        setError(err?.message || 'Failed to load PRs');
        setPulls([]);
      } finally {
        if (gen === listFetchGenRef.current) {
          setLoading(false);
          setRefreshing(false);
        }
      }
    },
    [projectId, state],
  );

  const loadListRef = useRef(loadList);
  loadListRef.current = loadList;

  // Recently pushed branches without an open PR — the GitHub-style
  // "Compare & pull request" banner (Hub-hosted projects only).
  const isHostedProject = project?.gitHost === 'agenthub';
  const [showNewPr, setShowNewPr] = useState(false);
  const [recentPushes, setRecentPushes] = useState<any[]>([]);
  const loadRecentPushes = useCallback(async () => {
    if (!projectId || !isHostedProject) return;
    try {
      const data = await api.getGitHostRecentPushes(projectId);
      setRecentPushes(data.pushes || []);
    } catch {
      setRecentPushes([]);
    }
  }, [projectId, isHostedProject]);

  const handleCreatePrFromBranch = useCallback(
    async (branch: any, { title, body }: any) => {
      const res = await api.createNativePr(projectId, {
        headBranch: branch,
        title,
        body,
      });
      if (typeof onToast === 'function') {
        onToast(
          res.created
            ? `PR #${res.number} opened for ${branch}.`
            : `PR #${res.number} already open.`,
          'success',
          5000,
        );
      }
      loadRecentPushes();
      loadListRef.current({ soft: true });
      setSelectedNumber(res.number);
      setDetail(null);
      loadDetailRef.current?.(res.number);
      return res;
    },
    [projectId, onToast, loadRecentPushes],
  );
  const loadDetailRef = useRef<any>(null);

  useEffect(() => {
    loadList({ soft: false });
    loadRecentPushes();
  }, [loadList, loadRecentPushes]);

  const selectedNumberRef = useRef<any>(null);
  useEffect(() => {
    if (!listRefreshNonce) return;
    loadListRef.current({ soft: true });
    loadRecentPushes();
    // Keep an open detail view live too — CI job/PR events bump this nonce.
    if (selectedNumberRef.current) loadDetailRef.current?.(selectedNumberRef.current);
  }, [listRefreshNonce, loadRecentPushes]);

  const loadDetail = useCallback(
    async (number: any) => {
      if (!projectId || !number) return;
      const gen = ++detailFetchGenRef.current;
      setDetailLoading(true);
      setDetailError(null);
      try {
        const data = await api.getProjectPullDetail(projectId, number);
        if (gen !== detailFetchGenRef.current) return;
        setDetail(data);
      } catch (err: any) {
        if (gen !== detailFetchGenRef.current) return;
        console.warn('Failed to load PR detail:', err?.message || err);
        setDetailError(err?.message || 'Failed to load PR');
        setDetail(null);
      } finally {
        if (gen === detailFetchGenRef.current) {
          setDetailLoading(false);
        }
      }
    },
    [projectId],
  );

  useEffect(() => {
    if (initialPrNumber == null || !projectId) return;
    const n = Number.parseInt(String(initialPrNumber), 10);
    if (!Number.isFinite(n) || n < 1) return;
    setSelectedNumber(n);
    setDetail(null);
    loadDetail(n);
  }, [initialPrNumber, projectId, loadDetail]);

  loadDetailRef.current = loadDetail;
  selectedNumberRef.current = selectedNumber;

  // Poll while checks are running so job states tick over even if a WS
  // event is missed (mirrors the Runners page's live polling).
  const hasLiveChecks =
    Array.isArray(detail?.checks) &&
    detail.checks.some((c: any) => c.status === 'queued' || c.status === 'in_progress');
  useEffect(() => {
    if (!hasLiveChecks || !selectedNumber) return undefined;
    const t = setInterval(() => loadDetailRef.current?.(selectedNumber), 8000);
    return () => clearInterval(t);
  }, [hasLiveChecks, selectedNumber]);

  const handleSelect = (pr: any) => {
    setSelectedNumber(pr.number);
    setDetail(null);
    loadDetail(pr.number);
  };

  const handleBack = () => {
    setSelectedNumber(null);
    setDetail(null);
    setDetailError(null);
  };

  const handleRefresh = () => {
    setRefreshing(true);
    if (selectedNumber) {
      loadDetail(selectedNumber).finally(() => setRefreshing(false));
    } else {
      loadList({ soft: true });
    }
  };

  const applyResolveOutcome = useCallback(
    (res: any, prLabel: any, prNumber: any, { legacyDetailCleanCopy = false }: any = {}) => {
      if (res?.sessionId) {
        if (prNumber != null) {
          setSessionSpawnedByPr((prev: any) => ({ ...prev, [prNumber]: res.sessionId }));
        }
        if (typeof onToast === 'function') {
          const kinds = Array.isArray(res.triggered) ? res.triggered.join(', ') : '';
          onToast(
            kinds
              ? `Resolving ${prLabel} — ${kinds}`
              : `Resolving ${prLabel} — agent session started`,
            'success',
            5000,
          );
        }
      } else if (typeof onToast === 'function') {
        onToast(
          legacyDetailCleanCopy
            ? 'Nothing to resolve — PR looks clean.'
            : `Nothing to resolve — ${prLabel} looks clean.`,
          'info',
          5000,
        );
      }
    },
    [onToast],
  );

  const handleResolve = useCallback(async () => {
    if (!projectId || !selectedNumber || !resolveAgentId || resolving) return;
    const prLabel = `PR #${selectedNumber}`;
    setResolving(true);
    try {
      const res = await api.resolvePR(projectId, selectedNumber, {
        agentId: resolveAgentId,
      });
      applyResolveOutcome(res, prLabel, selectedNumber, { legacyDetailCleanCopy: true });
    } catch (err: any) {
      const msg = err?.message || 'Failed to resolve PR';
      if (typeof onToast === 'function') {
        onToast(`Resolve PR failed: ${msg}`, 'error', 6000);
      } else {
        console.warn('Resolve PR failed:', msg);
      }
    } finally {
      setResolving(false);
    }
  }, [projectId, selectedNumber, resolveAgentId, resolving, applyResolveOutcome, onToast]);

  const handleMerge = useCallback(async () => {
    if (!projectId || !selectedNumber || mergingDetail) return;
    const pr = detail?.pr;
    if (!pr?.html_url) {
      if (typeof onToast === 'function') {
        onToast('Cannot merge: no GitHub URL on this PR.', 'error', 5000);
      }
      return;
    }
    if (!mergeButtonState(pr).enabled) return;
    const prLabel = `PR #${selectedNumber}`;
    setMergingDetail(true);
    try {
      const res = await api.mergePr(pr.html_url, 'squash');
      if (typeof onToast === 'function') {
        onToast(
          res?.alreadyMerged ? `${prLabel} was already merged.` : `${prLabel} merged.`,
          'success',
          5000,
        );
      }
      // Refresh detail + list so badges/state reflect the merge.
      loadDetail(selectedNumber);
      loadListRef.current({ soft: true });
    } catch (err: any) {
      const msg = err?.message || 'Failed to merge PR';
      if (typeof onToast === 'function') {
        onToast(`Merge failed (${prLabel}): ${msg.replace(/^(\d{3}):\s*/, '')}`, 'error', 7000);
      } else {
        console.warn('Merge failed:', msg);
      }
    } finally {
      setMergingDetail(false);
    }
  }, [projectId, selectedNumber, mergingDetail, detail, onToast, loadDetail]);

  const handleMergeFromList = useCallback(
    async (prNumber: any) => {
      if (!projectId || bulkResolving || mergingFromList != null) return;
      const pr = pulls.find((p: any) => p.number === prNumber);
      if (!pr?.html_url) {
        if (typeof onToast === 'function') {
          onToast(`PR #${prNumber}: no GitHub URL.`, 'error', 5000);
        }
        return;
      }
      if (!mergeButtonState(pr).enabled) return;
      const prLabel = `PR #${prNumber}`;
      setMergingFromList(prNumber);
      try {
        const res = await api.mergePr(pr.html_url, 'squash');
        if (typeof onToast === 'function') {
          onToast(
            res?.alreadyMerged ? `${prLabel} was already merged.` : `${prLabel} merged.`,
            'success',
            5000,
          );
        }
        loadListRef.current({ soft: true });
      } catch (err: any) {
        const msg = err?.message || 'Failed to merge PR';
        if (typeof onToast === 'function') {
          onToast(`Merge failed (${prLabel}): ${msg.replace(/^(\d{3}):\s*/, '')}`, 'error', 7000);
        } else {
          console.warn('Merge failed:', msg);
        }
      } finally {
        setMergingFromList(null);
      }
    },
    [projectId, pulls, bulkResolving, mergingFromList, onToast],
  );

  const handleResolveFromList = useCallback(
    async (prNumber: any) => {
      if (!projectId || !resolveAgentId || bulkResolving || resolvingFromList != null) return;
      const prLabel = `PR #${prNumber}`;
      setResolvingFromList(prNumber);
      try {
        const res = await api.resolvePR(projectId, prNumber, { agentId: resolveAgentId });
        applyResolveOutcome(res, prLabel, prNumber);
      } catch (err: any) {
        const msg = err?.message || 'Failed to resolve PR';
        if (typeof onToast === 'function') {
          onToast(`Resolve PR failed (${prLabel}): ${msg}`, 'error', 6000);
        } else {
          console.warn('Resolve PR failed:', msg);
        }
      } finally {
        setResolvingFromList(null);
      }
    },
    [projectId, resolveAgentId, bulkResolving, resolvingFromList, applyResolveOutcome, onToast],
  );

  const handleResolveAll = useCallback(async () => {
    if (
      !projectId ||
      !resolveAgentId ||
      pulls.length === 0 ||
      bulkResolving ||
      resolvingFromList != null
    ) {
      return;
    }
    setBulkResolving(true);
    let spawned = 0;
    let clean = 0;
    let failed = 0;
    try {
      for (const pr of pulls) {
        try {
          const res = await api.resolvePR(projectId, pr.number, { agentId: resolveAgentId });
          if (res?.sessionId) {
            spawned += 1;
            setSessionSpawnedByPr((prev: any) => ({ ...prev, [pr.number]: res.sessionId }));
            const kinds = Array.isArray(res.triggered) ? res.triggered.join(', ') : '';
            if (typeof onToast === 'function') {
              onToast(
                kinds
                  ? `PR #${pr.number}: session started (${kinds})`
                  : `PR #${pr.number}: agent session started`,
                'success',
                4000,
              );
            }
          } else {
            clean += 1;
          }
        } catch (err: any) {
          failed += 1;
          const msg = err?.message || 'error';
          if (typeof onToast === 'function') {
            onToast(`PR #${pr.number}: resolve failed — ${msg}`, 'error', 5500);
          }
        }
      }
      if (typeof onToast === 'function') {
        const parts = [
          `${spawned} session(s) started`,
          `${clean} already clean`,
          failed ? `${failed} failed` : null,
        ].filter(Boolean);
        onToast(
          `Resolve all finished: ${parts.join(', ')}.`,
          spawned > 0 ? 'success' : 'info',
          8000,
        );
      }
    } finally {
      setBulkResolving(false);
    }
  }, [projectId, resolveAgentId, pulls, bulkResolving, resolvingFromList, onToast]);

  // Memoized on the head-branch *content* (not the `pulls` array identity, which
  // gets a fresh reference on every soft refresh / WS-driven reload). A stable Set
  // reference keeps NewPrPanel's branch-scan effect from re-firing on every parent
  // render. See AH-1251 (the picker hammered the server and never left "Loading
  // branches…").
  const openPrHeadBranchKey = (pulls || []).map(prHeadBranch).filter(Boolean).sort().join('\n');
  const openPrHeadBranches = useMemo(
    () => new Set(openPrHeadBranchKey ? openPrHeadBranchKey.split('\n') : []),
    [openPrHeadBranchKey],
  );
  const visibleRecentPushes = (recentPushes || []).filter(
    (push: any) =>
      push?.branch &&
      !isAgentHubManagedSessionBranch(push.branch) &&
      !openPrHeadBranches.has(push.branch),
  );

  // ── Detail view ──
  if (selectedNumber) {
    if (detailLoading && !detail) {
      return (
        <div className="flex-1 flex items-center justify-center">
          <Loader2 size={24} className="animate-spin text-gray-500" />
        </div>
      );
    }
    if (detailError && !detailLoading) {
      return (
        <div className="flex-1 flex flex-col items-center justify-center gap-3 p-6">
          <AlertCircle size={24} className="text-red-400" />
          <p className="text-red-400 text-sm text-center">{detailError}</p>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => loadDetail(selectedNumber)}
              className="px-3 py-1.5 bg-gray-800 hover:bg-gray-700 text-white text-sm rounded-lg transition-colors"
            >
              Retry
            </button>
            <button
              type="button"
              onClick={handleBack}
              className="px-3 py-1.5 text-gray-400 hover:text-white text-sm transition-colors flex items-center gap-1.5"
            >
              <ArrowLeft size={14} />
              Back
            </button>
          </div>
        </div>
      );
    }
    if (detail) {
      return (
        <PrDetail
          detail={detail}
          onBack={handleBack}
          onRefresh={handleRefresh}
          refreshing={refreshing || detailLoading}
          onResolve={handleResolve}
          resolving={resolving}
          onMerge={handleMerge}
          merging={mergingDetail}
          agentId={resolveAgentId}
          spawnedSessionId={sessionSpawnedByPr[selectedNumber] || null}
          onOpenSession={onOpenSession}
          projectId={projectId}
          onToast={onToast}
          onOpenCard={onOpenCard}
        />
      );
    }
  }

  // ── List view ──
  return (
    <div className="flex-1 overflow-y-auto p-4 md:p-6">
      <div className="w-full">
        <div className="flex items-center justify-between mb-4 gap-3 flex-wrap">
          <div>
            <h2 className="text-2xl font-bold text-white flex items-center gap-3">
              <GitPullRequest size={28} />
              Pull Requests
            </h2>
            {project?.name && <p className="text-sm text-gray-400 mt-1">{project.name}</p>}
          </div>
          <div className="flex items-center gap-2 flex-shrink-0">
            <button
              type="button"
              onClick={handleResolveAll}
              disabled={
                !resolveAgentId ||
                pulls.length === 0 ||
                bulkResolving ||
                resolvingFromList != null ||
                loading
              }
              title={
                !resolveAgentId
                  ? 'No agents configured'
                  : pulls.length === 0
                    ? 'No pull requests to resolve'
                    : 'Run Resolve PR once for each row in this list (one session per PR)'
              }
              className="flex items-center gap-1.5 text-sm px-3 py-1.5 rounded-lg border border-gray-700 bg-gray-800/80 text-gray-200 hover:bg-gray-800 hover:text-white disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {bulkResolving ? (
                <Loader2 size={14} className="animate-spin text-gray-400" />
              ) : (
                <Wrench size={14} className="text-gray-400" />
              )}
              Resolve all
            </button>
            <button
              type="button"
              onClick={handleRefresh}
              disabled={refreshing || loading || bulkResolving}
              className="flex items-center gap-1.5 text-sm text-gray-400 hover:text-gray-200 disabled:opacity-50 transition-colors"
            >
              <RefreshCw size={14} className={refreshing ? 'animate-spin' : ''} />
              Refresh
            </button>
            {isHostedProject && (
              <button
                type="button"
                onClick={() => setShowNewPr((v: any) => !v)}
                data-testid="new-pr-button"
                className="flex items-center gap-1.5 text-sm bg-emerald-600 hover:bg-emerald-500 text-white px-3 py-1.5 rounded-lg transition-colors"
              >
                <GitPullRequest size={14} />
                New pull request
              </button>
            )}
          </div>
        </div>

        {showNewPr && isHostedProject && (
          <NewPrPanel
            projectId={projectId}
            onCreate={handleCreatePrFromBranch}
            onClose={() => setShowNewPr(false)}
            excludedBranches={openPrHeadBranches}
          />
        )}

        {/* GitHub-style "Compare & pull request" banners for recent pushes */}
        {visibleRecentPushes.map((push: any) => (
          <RecentPushBanner
            key={push.branch}
            push={push}
            onCreate={handleCreatePrFromBranch}
            projectId={projectId}
          />
        ))}

        {/* State tabs */}
        <div className="flex gap-2 mb-4">
          {STATE_TABS.map((tab: any) => (
            <button
              type="button"
              key={tab.key}
              onClick={() => setState(tab.key)}
              className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${
                state === tab.key
                  ? 'bg-gray-700 text-white'
                  : 'bg-gray-800 text-gray-400 hover:bg-gray-700/70 hover:text-gray-200'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {loading && pulls.length === 0 && (
          <div className="flex items-center justify-center py-16">
            <Loader2 size={24} className="animate-spin text-gray-500" />
          </div>
        )}

        {!loading && error && (
          <div className="bg-red-500/10 border border-red-500/20 rounded-lg p-4 flex items-start gap-2">
            <AlertCircle size={16} className="text-red-400 mt-0.5 flex-shrink-0" />
            <div className="flex-1 text-sm">
              <p className="text-red-400 font-medium">Failed to load pull requests</p>
              <p className="text-gray-400 mt-1">{error}</p>
            </div>
            <button
              type="button"
              onClick={loadList}
              className="text-sm text-red-300 hover:text-red-100 underline"
            >
              Retry
            </button>
          </div>
        )}

        {!loading && !error && pulls.length === 0 && (
          <div className="text-center py-16">
            <GitPullRequest size={48} className="mx-auto text-gray-600 mb-4" />
            <h3 className="text-lg font-medium text-gray-300 mb-2">No {state} pull requests</h3>
            <p className="text-gray-500 text-sm max-w-md mx-auto">
              Once this project&apos;s repo has PRs in the <code>{state}</code> state, they&apos;ll
              show up here.
            </p>
          </div>
        )}

        {pulls.length > 0 && (
          <div className="space-y-2">
            {pulls.map((pr: any) => (
              <PrListItem
                key={pr.number}
                pr={pr}
                onOpen={() => handleSelect(pr)}
                onResolveRow={handleResolveFromList}
                onMergeRow={handleMergeFromList}
                resolveAgentId={resolveAgentId}
                resolvingThisRow={resolvingFromList === pr.number}
                mergingThisRow={mergingFromList === pr.number}
                bulkResolving={bulkResolving}
                spawnedSessionId={sessionSpawnedByPr[pr.number] || null}
                onOpenSession={onOpenSession}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
