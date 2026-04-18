import { useState, useEffect, useCallback } from 'react';
import {
  GitPullRequest,
  CheckCircle2,
  XCircle,
  Clock,
  AlertCircle,
  ExternalLink,
  ArrowLeft,
  RefreshCw,
  Loader2,
  MessageSquare,
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
  checkRowStyle,
  reviewStateColor,
} from '../utils/prFormatting.js';

// ─── Shared atoms ──────────────────────────────────────────────

function Badge({ label, color, bg }) {
  return (
    <span
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

function PrListItem({ pr, onClick }) {
  const state = prStateBadge(pr);
  const diff = diffSummary(pr);
  return (
    <button
      type="button"
      onClick={onClick}
      className="w-full text-left bg-gray-900 border border-gray-800 rounded-lg p-4 hover:border-gray-700 transition-colors"
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

function PrDetail({ detail, onBack, onRefresh, refreshing }) {
  const pr = detail?.pr;
  if (!pr) return null;

  const state = prStateBadge(pr);
  const checksSummary = summarizeChecks(detail.checks);
  const cBadge = checksBadge(checksSummary);
  const reviewState = summarizeReviews(detail.reviews);
  const rBadge = reviewsBadge(reviewState);
  const mBadge = mergeableBadge(pr.mergeable);

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

export default function PullRequestsPage({ projectId, project }) {
  const [state, setState] = useState('open');
  const [pulls, setPulls] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [refreshing, setRefreshing] = useState(false);

  const [selectedNumber, setSelectedNumber] = useState(null);
  const [detail, setDetail] = useState(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState(null);

  const loadList = useCallback(async () => {
    if (!projectId) {
      setError('No project selected.');
      setLoading(false);
      return;
    }
    try {
      setError(null);
      const data = await api.getProjectPulls(projectId, { state, limit: 50 });
      setPulls(data.pulls || []);
    } catch (err) {
      console.warn('Failed to load PRs:', err?.message || err);
      setError(err?.message || 'Failed to load PRs');
      setPulls([]);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [projectId, state]);

  useEffect(() => {
    setLoading(true);
    loadList();
  }, [loadList]);

  const loadDetail = useCallback(
    async (number) => {
      if (!projectId || !number) return;
      setDetailLoading(true);
      setDetailError(null);
      try {
        const data = await api.getProjectPullDetail(projectId, number);
        setDetail(data);
      } catch (err) {
        console.warn('Failed to load PR detail:', err?.message || err);
        setDetailError(err?.message || 'Failed to load PR');
        setDetail(null);
      } finally {
        setDetailLoading(false);
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
      loadList();
    }
  };

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
        />
      );
    }
  }

  // ── List view ──
  return (
    <div className="flex-1 overflow-y-auto p-4 md:p-6">
      <div className="max-w-4xl mx-auto">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h2 className="text-2xl font-bold text-white flex items-center gap-3">
              <GitPullRequest size={28} />
              Pull Requests
            </h2>
            {project?.name && <p className="text-sm text-gray-400 mt-1">{project.name}</p>}
          </div>
          <button
            type="button"
            onClick={handleRefresh}
            disabled={refreshing || loading}
            className="flex items-center gap-1.5 text-sm text-gray-400 hover:text-gray-200 disabled:opacity-50 transition-colors"
          >
            <RefreshCw size={14} className={refreshing ? 'animate-spin' : ''} />
            Refresh
          </button>
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
              <PrListItem key={pr.number} pr={pr} onClick={() => handleSelect(pr)} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
