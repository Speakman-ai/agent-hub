import { useState, useEffect, useCallback, useRef } from 'react';
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
  BellRing,
} from 'lucide-react';
import { api } from '../utils/api.js';
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
  prListRowResolveDisabledHeuristic,
  mergeButtonState,
} from '../utils/prFormatting.js';

// ─── Shared atoms ──────────────────────────────────────────────

function Badge({ label, color, bg, title }) {
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
};

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
  onNudgeReviewerRow,
  onMergeRow,
  resolveAgentId,
  reviewerAgentId,
  resolvingThisRow,
  nudgingThisRow,
  mergingThisRow,
  bulkResolving,
  spawnedSessionId,
  onOpenSession,
}) {
  const state = prStateBadge(pr);
  const diff = diffSummary(pr);
  const showCi = Array.isArray(pr.check_rollup) && pr.check_rollup.length > 0;
  const ciBadge = showCi ? checksBadge(summarizeChecks(pr.check_rollup)) : null;
  const reviewB = reviewDecisionListBadge(pr.review_decision);
  const mBadge = mergeableBadge(pr.mergeable);
  const pipeB = mergePipelineListBadge(pr);
  const heuristicOff = prListRowResolveDisabledHeuristic(pr);
  const resolveBusy = bulkResolving || resolvingThisRow;
  const resolveDisabled = !resolveAgentId || resolveBusy || heuristicOff;
  const nudgeBusy = bulkResolving || nudgingThisRow;
  const nudgeDisabled = !reviewerAgentId || nudgeBusy;
  const mergeState = mergeButtonState(pr);
  const mergeBusy = bulkResolving || mergingThisRow;
  const mergeDisabled = !mergeState.enabled || mergeBusy;
  const mergeTitle = mergeBusy
    ? 'Merging…'
    : !pr.html_url
      ? 'No GitHub URL on this PR'
      : mergeState.reason;
  const nudgeTitle = !reviewerAgentId
    ? 'No reviewer agent on this project'
    : bulkResolving
      ? 'Bulk resolve in progress…'
      : nudgingThisRow
        ? 'Requesting review…'
        : 'Request a formal PR review from the reviewer agent';
  const resolveTitle = !resolveAgentId
    ? 'No agents configured'
    : bulkResolving
      ? 'Resolve all in progress…'
      : resolvingThisRow
        ? 'Resolving…'
        : heuristicOff
          ? 'Nothing to resolve from list metadata (open PR for full detail if needed)'
          : 'Resolve conflicts, CI failures, or review feedback for this PR';

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
            {pr.labels.slice(0, 4).map((l) => (
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
      <div className="flex-shrink-0 self-center flex flex-col gap-2 items-stretch">
        <button
          type="button"
          onClick={(e) => {
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
        <button
          type="button"
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            onNudgeReviewerRow(pr.number);
          }}
          disabled={nudgeDisabled}
          title={nudgeTitle}
          aria-label={`Nudge reviewer for PR #${pr.number}`}
          className="flex flex-col items-center justify-center gap-1 px-3 py-2 rounded-lg border border-violet-800/80 bg-violet-950/40 text-xs font-medium text-violet-200 hover:bg-violet-950/70 hover:text-white transition-colors disabled:opacity-50 disabled:cursor-not-allowed min-w-[5.5rem]"
        >
          {nudgingThisRow ? (
            <Loader2 size={16} className="animate-spin text-violet-300" />
          ) : (
            <BellRing size={16} className="text-violet-300" />
          )}
          <span>Nudge</span>
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
                onClick={(e) => {
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
            onClick={(e) => {
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

function SectionHeader({ children }) {
  return (
    <h3 className="text-xs font-semibold text-gray-300 uppercase tracking-wider mt-6 mb-2">
      {children}
    </h3>
  );
}

function CheckRow({ chk }) {
  const style = checkRowStyle(chk);
  const Icon = CHECK_ICONS[style.iconKey] || AlertCircle;
  const label = (chk.conclusion || chk.status || '').toLowerCase();
  const clickable = !!chk.html_url;
  const RowTag = clickable ? 'a' : 'div';
  const rowProps = clickable
    ? { href: chk.html_url, target: '_blank', rel: 'noopener noreferrer' }
    : {};
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
    </RowTag>
  );
}

function ReviewBlock({ review }) {
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

function CommentBlock({ comment }) {
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

function PrDetail({
  detail,
  onBack,
  onRefresh,
  refreshing,
  onResolve,
  resolving,
  onNudgeReviewer,
  nudgingReviewer,
  onMerge,
  merging,
  agentId,
  reviewerAgentId,
  spawnedSessionId,
  onOpenSession,
}) {
  const pr = detail?.pr;
  if (!pr) return null;

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
      : 'Spawn an agent session to resolve conflicts, CI failures, or review feedback on this PR';

  const nudgeDisabled = nudgingReviewer || !reviewerAgentId;
  const nudgeTitle = !reviewerAgentId
    ? 'No reviewer agent on this project'
    : nudgingReviewer
      ? 'Requesting review…'
      : 'Request a formal PR review from the reviewer agent';

  const mergeState = mergeButtonState(pr);
  const mergeDisabled = merging || !mergeState.enabled || !pr.html_url;
  const mergeTitle = merging
    ? 'Merging…'
    : !pr.html_url
      ? 'No GitHub URL on this PR'
      : mergeState.reason;

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-4xl mx-auto p-4 md:p-6">
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
          <button
            type="button"
            onClick={onNudgeReviewer}
            disabled={nudgeDisabled}
            title={nudgeTitle}
            className="flex items-center gap-1.5 text-sm text-violet-300 hover:text-violet-100 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {nudgingReviewer ? (
              <Loader2 size={14} className="animate-spin text-violet-300" />
            ) : (
              <BellRing size={14} className="text-violet-300" />
            )}
            Nudge reviewer
          </button>
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
        </div>
        <h2 className="text-xl font-semibold text-white mb-2">{pr.title}</h2>

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

        {Array.isArray(pr.labels) && pr.labels.length > 0 && (
          <div className="mt-3 flex flex-wrap gap-1">
            {pr.labels.map((l) => (
              <span
                key={l.name}
                className="px-1.5 py-0.5 text-[10px] text-gray-300 bg-gray-800 rounded"
              >
                {l.name}
              </span>
            ))}
          </div>
        )}

        {pr.html_url && (
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

        {/* Summary strip: checks + reviews + mergeable */}
        <div className="flex flex-wrap gap-2 mt-5">
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

        {/* CI Checks */}
        <SectionHeader>CI Checks</SectionHeader>
        {(!detail.checks || detail.checks.length === 0) && (
          <p className="text-sm text-gray-500">No checks reported.</p>
        )}
        {Array.isArray(detail.checks) && detail.checks.length > 0 && (
          <div className="bg-gray-900/40 border border-gray-800 rounded-lg overflow-hidden">
            {detail.checks.map((chk, i) => (
              <CheckRow key={chk.id || chk.name || i} chk={chk} />
            ))}
          </div>
        )}

        {/* Reviews */}
        <SectionHeader>Reviews</SectionHeader>
        {(!detail.reviews || detail.reviews.length === 0) && (
          <p className="text-sm text-gray-500">No reviews yet.</p>
        )}
        {Array.isArray(detail.reviews) &&
          detail.reviews.map((r) => <ReviewBlock key={r.id} review={r} />)}

        {/* Comments */}
        <SectionHeader>Comments</SectionHeader>
        {(!detail.comments || detail.comments.length === 0) && (
          <p className="text-sm text-gray-500 flex items-center gap-1.5">
            <MessageSquare size={12} />
            No comments.
          </p>
        )}
        {Array.isArray(detail.comments) &&
          detail.comments.map((c) => <CommentBlock key={c.id} comment={c} />)}

        <div className="h-10" />
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
  /** Bumped from App when GitHub/kanban activity should re-sync the open PR list. */
  listRefreshNonce = 0,
}) {
  const [state, setState] = useState('open');
  const [pulls, setPulls] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [refreshing, setRefreshing] = useState(false);

  const [selectedNumber, setSelectedNumber] = useState(null);
  const [detail, setDetail] = useState(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState(null);
  const [resolving, setResolving] = useState(false);
  const [resolvingFromList, setResolvingFromList] = useState(null);
  const [nudgingFromList, setNudgingFromList] = useState(null);
  const [nudgingDetail, setNudgingDetail] = useState(false);
  const [mergingDetail, setMergingDetail] = useState(false);
  const [mergingFromList, setMergingFromList] = useState(null);
  const [bulkResolving, setBulkResolving] = useState(false);
  /** PR numbers for which a resolve run spawned a session (inline checkmark; no auto navigation). */
  const [sessionSpawnedByPr, setSessionSpawnedByPr] = useState(() => ({}));

  const resolveAgentId =
    Array.isArray(project?.agents) && project.agents.length > 0
      ? typeof project.agents[0] === 'string'
        ? project.agents[0]
        : project.agents[0]?.id
      : null;

  const reviewerAgentId = Array.isArray(project?.agents)
    ? (() => {
        for (const a of project.agents) {
          if (typeof a === 'object' && a?.role === 'reviewer' && typeof a.id === 'string') {
            return a.id;
          }
        }
        return null;
      })()
    : null;

  /** Monotonic counter so an older in-flight list fetch cannot clobber newer results (Strict Mode / rapid tab switches). */
  const listFetchGenRef = useRef(0);
  const detailFetchGenRef = useRef(0);

  const loadList = useCallback(
    async ({ soft = false } = {}) => {
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
      } catch (err) {
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

  useEffect(() => {
    loadList({ soft: false });
  }, [loadList]);

  useEffect(() => {
    if (!listRefreshNonce) return;
    loadListRef.current({ soft: true });
  }, [listRefreshNonce]);

  const loadDetail = useCallback(
    async (number) => {
      if (!projectId || !number) return;
      const gen = ++detailFetchGenRef.current;
      setDetailLoading(true);
      setDetailError(null);
      try {
        const data = await api.getProjectPullDetail(projectId, number);
        if (gen !== detailFetchGenRef.current) return;
        setDetail(data);
      } catch (err) {
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

  const handleSelect = (pr) => {
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
    (res, prLabel, prNumber, { legacyDetailCleanCopy = false } = {}) => {
      if (res?.sessionId) {
        if (prNumber != null) {
          setSessionSpawnedByPr((prev) => ({ ...prev, [prNumber]: res.sessionId }));
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
    } catch (err) {
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

  const handleNudgeReviewer = useCallback(async () => {
    if (!projectId || !selectedNumber || !reviewerAgentId || nudgingDetail) return;
    setNudgingDetail(true);
    try {
      await api.nudgePrReviewer(projectId, selectedNumber);
      if (typeof onToast === 'function') {
        onToast(
          'Formal review queued — the reviewer session will appear in the sidebar shortly.',
          'success',
          6000,
        );
      }
    } catch (err) {
      const raw = err?.message || 'Failed to nudge reviewer';
      if (typeof onToast === 'function') {
        onToast(raw.replace(/^(\d{3}):\s*/, ''), 'error', 7000);
      } else {
        console.warn('Nudge reviewer failed:', raw);
      }
    } finally {
      setNudgingDetail(false);
    }
  }, [projectId, selectedNumber, reviewerAgentId, nudgingDetail, onToast]);

  const handleNudgeFromList = useCallback(
    async (prNumber) => {
      if (!projectId || !reviewerAgentId || bulkResolving || nudgingFromList != null) return;
      setNudgingFromList(prNumber);
      try {
        await api.nudgePrReviewer(projectId, prNumber);
        if (typeof onToast === 'function') {
          onToast(
            `PR #${prNumber}: formal review queued — check the reviewer agent shortly.`,
            'success',
            6000,
          );
        }
      } catch (err) {
        const raw = err?.message || 'Failed to nudge reviewer';
        if (typeof onToast === 'function') {
          onToast(`PR #${prNumber}: ${raw.replace(/^(\d{3}):\s*/, '')}`, 'error', 7000);
        } else {
          console.warn('Nudge reviewer failed:', raw);
        }
      } finally {
        setNudgingFromList(null);
      }
    },
    [projectId, reviewerAgentId, bulkResolving, nudgingFromList, onToast],
  );

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
    } catch (err) {
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
    async (prNumber) => {
      if (!projectId || bulkResolving || mergingFromList != null) return;
      const pr = pulls.find((p) => p.number === prNumber);
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
      } catch (err) {
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
    async (prNumber) => {
      if (!projectId || !resolveAgentId || bulkResolving || resolvingFromList != null) return;
      const prLabel = `PR #${prNumber}`;
      setResolvingFromList(prNumber);
      try {
        const res = await api.resolvePR(projectId, prNumber, { agentId: resolveAgentId });
        applyResolveOutcome(res, prLabel, prNumber);
      } catch (err) {
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
            setSessionSpawnedByPr((prev) => ({ ...prev, [pr.number]: res.sessionId }));
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
        } catch (err) {
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
          onNudgeReviewer={handleNudgeReviewer}
          nudgingReviewer={nudgingDetail}
          onMerge={handleMerge}
          merging={mergingDetail}
          agentId={resolveAgentId}
          reviewerAgentId={reviewerAgentId}
          spawnedSessionId={sessionSpawnedByPr[selectedNumber] || null}
          onOpenSession={onOpenSession}
        />
      );
    }
  }

  // ── List view ──
  return (
    <div className="flex-1 overflow-y-auto p-4 md:p-6">
      <div className="max-w-4xl mx-auto">
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
          </div>
        </div>

        {/* State tabs */}
        <div className="flex gap-2 mb-4">
          {STATE_TABS.map((tab) => (
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
            {pulls.map((pr) => (
              <PrListItem
                key={pr.number}
                pr={pr}
                onOpen={() => handleSelect(pr)}
                onResolveRow={handleResolveFromList}
                onNudgeReviewerRow={handleNudgeFromList}
                onMergeRow={handleMergeFromList}
                resolveAgentId={resolveAgentId}
                reviewerAgentId={reviewerAgentId}
                resolvingThisRow={resolvingFromList === pr.number}
                nudgingThisRow={nudgingFromList === pr.number}
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
