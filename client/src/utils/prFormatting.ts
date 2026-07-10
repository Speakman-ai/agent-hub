// Pure formatting helpers for the web PR viewer.
// Ported from mobile/src/utils/prFormatting.js — RN inline styles are replaced
// with Tailwind class-name strings so the same semantic helpers can drive
// <span className={`${bg} ${color}`}> badges. Kept pure so they're trivial to
// unit test without rendering React.

// Tailwind class tokens (kept terse so badges stay visually consistent with
// the rest of the app).
const TOKEN = {
  gray: { text: 'text-gray-400', bg: 'bg-gray-500/10', border: 'border-gray-500/20' },
  emerald: { text: 'text-emerald-400', bg: 'bg-emerald-500/10', border: 'border-emerald-500/20' },
  red: { text: 'text-red-400', bg: 'bg-red-500/10', border: 'border-red-500/20' },
  yellow: { text: 'text-yellow-400', bg: 'bg-yellow-500/10', border: 'border-yellow-500/20' },
  blue: { text: 'text-blue-400', bg: 'bg-blue-500/10', border: 'border-blue-500/20' },
  purple: { text: 'text-purple-400', bg: 'bg-purple-500/10', border: 'border-purple-500/20' },
} as Record<string, any>;

/**
 * Extract the numeric ID from a PR URL. Matches both GitHub (`/pull/N`)
 * and Agent Hub-native (`/pulls/N`) URL shapes.
 * @param {string} prUrl
 * @returns {string|null}
 */
export function prNumberFromUrl(prUrl: any) {
  if (!prUrl || typeof prUrl !== 'string') return null;
  const m = prUrl.match(/\/pulls?\/(\d+)(?:$|[?#/])/);
  return m ? m[1] : null;
}

/**
 * Parse an Agent Hub-native PR URL (`/projects/<id>/pulls/<n>`, with or
 * without an http(s) origin). These are emitted by the server for
 * projects hosted on Agent Hub (`gitHost: 'agenthub'`) and should open
 * the in-app PR detail view instead of an external tab.
 * @param {string|null|undefined} prUrl
 * @returns {{projectId: string, number: number}|null}
 */
export function parseNativePrUrl(prUrl: any) {
  if (!prUrl || typeof prUrl !== 'string') return null;
  const m = prUrl
    .trim()
    .match(/^(?:https?:\/\/[^/]+)?\/projects\/([^/\s]+)\/pulls\/(\d+)(?:[?#].*)?$/);
  if (!m) return null;
  const number = Number.parseInt(m[2], 10);
  if (!Number.isFinite(number) || number <= 0) return null;
  return { projectId: m[1], number };
}

/**
 * True when `prUrl` is an Agent Hub-native PR URL.
 * @param {string|null|undefined} prUrl
 */
export function isNativePrUrl(prUrl: any) {
  return parseNativePrUrl(prUrl) !== null;
}

/**
 * If `prUrl` is a github.com pull request URL, returns normalized `owner/repo`
 * (lowercase). Otherwise null — callers fall back to project-scoped PR detail fetch.
 * @param {string|null|undefined} prUrl
 * @returns {string|null}
 */
export function parseGithubPullFullName(prUrl: any) {
  if (!prUrl || typeof prUrl !== 'string') return null;
  const m = prUrl.match(/https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/\d+/i);
  return m ? `${m[1]}/${m[2]}`.toLowerCase() : null;
}

/**
 * True when `GET .../pulls/:n` for this project is expected to describe the same PR as `prUrl`.
 * Skips when the URL names a different repo than the project (cross-repo links / title inference).
 * @param {string|null|undefined} prUrl
 * @param {string|null|undefined} projectGithubRepo `owner/repo` from project settings
 */
export function shouldFetchProjectPullDetail(prUrl: any, projectGithubRepo: any) {
  const urlRepo = parseGithubPullFullName(prUrl);
  if (!urlRepo) return true;
  const proj =
    typeof projectGithubRepo === 'string' && projectGithubRepo.includes('/')
      ? projectGithubRepo.trim().toLowerCase()
      : null;
  if (!proj) return false;
  return urlRepo === proj;
}

/**
 * Short human-readable relative time, e.g. "2m ago", "3h ago", "4d ago".
 * Falls back to locale date for anything older than ~30 days.
 * @param {string|null|undefined} iso
 */
export function relativePrTime(iso: any) {
  if (!iso) return '';
  const t = typeof iso === 'string' ? Date.parse(iso) : NaN;
  if (!Number.isFinite(t)) return '';
  const now = Date.now();
  const deltaSec = Math.max(0, Math.floor((now - t) / 1000));
  if (deltaSec < 60) return `${deltaSec}s ago`;
  const deltaMin = Math.floor(deltaSec / 60);
  if (deltaMin < 60) return `${deltaMin}m ago`;
  const deltaHr = Math.floor(deltaMin / 60);
  if (deltaHr < 24) return `${deltaHr}h ago`;
  const deltaDay = Math.floor(deltaHr / 24);
  if (deltaDay < 30) return `${deltaDay}d ago`;
  try {
    return new Date(t).toLocaleDateString();
  } catch {
    return '';
  }
}

/**
 * Summarize diff stats into a compact "+10 · -2 · 4 files" string.
 * @param {{additions?: number, deletions?: number, changed_files?: number}} pr
 */
export function diffSummary(pr: any) {
  if (!pr) return '';
  const adds = Number.isFinite(pr.additions) ? pr.additions : null;
  const dels = Number.isFinite(pr.deletions) ? pr.deletions : null;
  const files = Number.isFinite(pr.changed_files) ? pr.changed_files : null;
  const parts: any[] = [];
  if (adds !== null) parts.push(`+${adds}`);
  if (dels !== null) parts.push(`-${dels}`);
  if (files !== null) parts.push(`${files} file${files === 1 ? '' : 's'}`);
  return parts.join(' · ');
}

/**
 * Pick a status label + Tailwind color classes for a PR given its state + draft flag.
 * @param {{state?: string, draft?: boolean, merged_at?: string|null}} pr
 */
export function prStateBadge(pr: any) {
  if (!pr) return { label: 'unknown', color: TOKEN.gray.text, bg: TOKEN.gray.bg };
  if (pr.merged_at) return { label: 'merged', color: TOKEN.purple.text, bg: TOKEN.purple.bg };
  if (pr.draft) return { label: 'draft', color: TOKEN.gray.text, bg: TOKEN.gray.bg };
  const s = (pr.state || '').toLowerCase();
  if (s === 'open') return { label: 'open', color: TOKEN.emerald.text, bg: TOKEN.emerald.bg };
  if (s === 'closed') return { label: 'closed', color: TOKEN.red.text, bg: TOKEN.red.bg };
  return { label: s || 'unknown', color: TOKEN.gray.text, bg: TOKEN.gray.bg };
}

/**
 * Compact linked-PR status for session summary (merged, review, conflicts, closed).
 * @param {{ pr?: { state?: string, merged_at?: string|null, mergeable?: boolean|null, review_decision?: string|null }|null,
 *           linkedCardReviewStatus?: string|null,
 *           reviews?: Array<{ state?: string, user?: string|null, submitted_at?: string|null }> }} input
 * @returns {{ key: string, label: string, color: string, bg: string }|null}
 */
export function linkedPrDisplayStatus({ pr, linkedCardReviewStatus, reviews }: any) {
  const card = (linkedCardReviewStatus || '').toLowerCase();
  const rev = summarizeReviews(reviews);

  if (pr?.merged_at) {
    return { key: 'merged', label: 'Merged', color: TOKEN.purple.text, bg: TOKEN.purple.bg };
  }
  if (pr?.mergeable === false) {
    return { key: 'conflicts', label: 'Has conflicts', color: TOKEN.red.text, bg: TOKEN.red.bg };
  }
  const state = (pr?.state || '').toLowerCase();
  if (state === 'closed') {
    return { key: 'closed', label: 'Closed', color: TOKEN.red.text, bg: TOKEN.red.bg };
  }
  if (card === 'changes_requested' || rev === 'changes_requested') {
    return {
      key: 'pending_revisions',
      label: 'Pending revisions',
      color: TOKEN.red.text,
      bg: TOKEN.red.bg,
    };
  }

  const reviewDecision = (pr?.review_decision || '').toUpperCase();
  const pendingReview =
    card === 'awaiting_review' ||
    card === 'reviewing' ||
    rev === 'pending' ||
    reviewDecision === 'REVIEW_REQUIRED' ||
    (rev === 'none' && state === 'open');

  if (pendingReview) {
    return {
      key: 'pending_review',
      label: 'Pending review',
      color: TOKEN.yellow.text,
      bg: TOKEN.yellow.bg,
    };
  }

  if (state === 'open') {
    return {
      key: 'pending_review',
      label: 'Pending review',
      color: TOKEN.yellow.text,
      bg: TOKEN.yellow.bg,
    };
  }

  return null;
}

/**
 * Single status pill for an open PR on the org dashboard. Conflicts beat review
 * state; changes-requested beats approved; awaiting review is the fallback when
 * a review is outstanding.
 *
 * @param {{ mergeable?: boolean|null, reviewDecision?: string|null, reviewStatus?: string|null }} pr
 * @returns {{ key: string, label: string, color: string, bg: string }|null}
 */
export function openPrDashboardStatusBadge(pr: any) {
  if (!pr) return null;
  if (pr.mergeable === false) {
    return { key: 'conflicts', label: 'Conflicts', color: TOKEN.red.text, bg: TOKEN.red.bg };
  }

  const card = (pr.reviewStatus || '').toLowerCase();
  const decision = (pr.reviewDecision || '').toUpperCase();

  if (card === 'changes_requested' || decision === 'CHANGES_REQUESTED') {
    return {
      key: 'requested_changes',
      label: 'Requested changes',
      color: TOKEN.red.text,
      bg: TOKEN.red.bg,
    };
  }
  if (decision === 'APPROVED' || card === 'approved') {
    return { key: 'approved', label: 'Approved', color: TOKEN.emerald.text, bg: TOKEN.emerald.bg };
  }
  if (card === 'awaiting_review' || card === 'reviewing' || decision === 'REVIEW_REQUIRED') {
    return {
      key: 'awaiting_review',
      label: 'Awaiting review',
      color: TOKEN.yellow.text,
      bg: TOKEN.yellow.bg,
    };
  }

  return null;
}

/**
 * Decide whether the "Mergeable" / "Conflicts" badge should render.
 * Only show when `mergeable` is a real boolean. `null` means GitHub is still
 * computing — suppress the badge rather than showing a misleading "Conflicts".
 * @param {boolean|null|undefined} mergeable
 * @returns {{show:boolean,label?:string,good?:boolean}}
 */
export function mergeableBadge(mergeable: any) {
  if (typeof mergeable !== 'boolean') return { show: false };
  return { show: true, label: mergeable ? 'Mergeable' : 'Conflicts', good: mergeable };
}

/**
 * Decide whether the "Merge" button should be enabled for a PR, plus the
 * tooltip explaining why if not.
 *
 * Merge is only enabled when:
 *  - the PR is open (not closed/merged/draft)
 *  - GitHub has finished computing mergeability and reports `mergeable === true`
 *
 * `mergeable === null` means GitHub is still computing — we keep the button
 * disabled with an explanatory tooltip rather than letting the user click and
 * fail.
 *
 * @param {{state?:string, draft?:boolean, merged_at?:string|null,
 *          mergeable?:boolean|null}} pr
 * @returns {{enabled:boolean, reason:string}}
 */
export function mergeButtonState(pr: any) {
  if (!pr) return { enabled: false, reason: 'No PR data' };
  if (pr.merged_at) return { enabled: false, reason: 'Already merged' };
  if (pr.draft) return { enabled: false, reason: 'PR is a draft' };
  const s = (pr.state || '').toLowerCase();
  if (s && s !== 'open') return { enabled: false, reason: `PR is ${s}` };
  // Branch protection (native PRs): the server-computed block reason wins
  // over mergeability — the merge endpoint would 409 with this message.
  if (pr.merge_blocked_reason) return { enabled: false, reason: pr.merge_blocked_reason };
  if (pr.mergeable === true) return { enabled: true, reason: 'Squash and merge this PR' };
  if (pr.mergeable === false) return { enabled: false, reason: 'PR has merge conflicts' };
  return { enabled: false, reason: 'GitHub is still computing mergeability — try Refresh' };
}

/**
 * Aggregate check-runs into pass/fail/pending counts + an overall badge.
 * Mirrors GitHub's "Checks" strip logic.
 * @param {Array<{status?:string, conclusion?:string}>} checks
 */
export function summarizeChecks(checks: any) {
  const arr = Array.isArray(checks) ? checks : [];
  const total = arr.length;
  let success = 0;
  let failure = 0;
  let pending = 0;
  let neutral = 0;
  for (const c of arr) {
    const status = (c.status || '').toLowerCase();
    const concl = (c.conclusion || '').toLowerCase();
    if (status && status !== 'completed') {
      pending += 1;
      continue;
    }
    if (
      concl === 'failure' ||
      concl === 'timed_out' ||
      concl === 'cancelled' ||
      concl === 'action_required'
    ) {
      failure += 1;
      continue;
    }
    if (concl === 'success' || concl === 'skipped' || concl === 'neutral') {
      success += 1;
      continue;
    }
    neutral += 1;
  }
  let overall: any;
  if (total === 0) overall = 'none';
  else if (failure > 0) overall = 'failure';
  else if (pending > 0) overall = 'pending';
  else overall = 'success';
  return { total, success, failure, pending, neutral, overall };
}

/**
 * Tailwind badge label + color classes for aggregated check runs.
 */
export function checksBadge(summary: any) {
  if (!summary || summary.overall === 'none') {
    return { label: 'No checks', color: TOKEN.gray.text, bg: TOKEN.gray.bg };
  }
  if (summary.overall === 'success') {
    return {
      label: `${summary.success}/${summary.total} passed`,
      color: TOKEN.emerald.text,
      bg: TOKEN.emerald.bg,
    };
  }
  if (summary.overall === 'failure') {
    return {
      label: `${summary.failure}/${summary.total} failing`,
      color: TOKEN.red.text,
      bg: TOKEN.red.bg,
    };
  }
  return {
    label: `${summary.pending}/${summary.total} running`,
    color: TOKEN.yellow.text,
    bg: TOKEN.yellow.bg,
  };
}

/**
 * Derive an overall review status from a list of reviews.
 * Later reviews by the same user supersede earlier ones, except COMMENTED
 * never supersedes a prior APPROVED/CHANGES_REQUESTED.
 * @param {Array<{user?:string|null, state?:string, submitted_at?:string|null}>} reviews
 * @returns {'approved'|'changes_requested'|'commented'|'pending'|'none'}
 */
export function summarizeReviews(reviews: any) {
  const arr = Array.isArray(reviews) ? reviews : [];
  if (arr.length === 0) return 'none';
  const byUser = new Map();
  const sorted = [...arr].sort((a: any, b: any) => {
    const ta = a.submitted_at ? Date.parse(a.submitted_at) : 0;
    const tb = b.submitted_at ? Date.parse(b.submitted_at) : 0;
    return ta - tb;
  });
  for (const r of sorted) {
    const key = r.user || '__anon__';
    const state = (r.state || '').toUpperCase();
    const prev = byUser.get(key);
    if (state === 'COMMENTED' && prev && prev !== 'COMMENTED') continue;
    byUser.set(key, state);
  }
  const states = [...byUser.values()];
  if (states.some((s: any) => s === 'CHANGES_REQUESTED')) return 'changes_requested';
  if (states.some((s: any) => s === 'APPROVED')) return 'approved';
  if (states.some((s: any) => s === 'COMMENTED')) return 'commented';
  if (states.some((s: any) => s === 'PENDING')) return 'pending';
  return 'none';
}

/**
 * Tailwind badge for aggregated review state.
 */
export function reviewsBadge(state: any) {
  switch (state) {
    case 'approved':
      return { label: 'Approved', color: TOKEN.emerald.text, bg: TOKEN.emerald.bg };
    case 'changes_requested':
      return { label: 'Changes requested', color: TOKEN.red.text, bg: TOKEN.red.bg };
    case 'commented':
      return { label: 'Commented', color: TOKEN.blue.text, bg: TOKEN.blue.bg };
    case 'pending':
      return { label: 'Pending review', color: TOKEN.yellow.text, bg: TOKEN.yellow.bg };
    default:
      return { label: 'No reviews', color: TOKEN.gray.text, bg: TOKEN.gray.bg };
  }
}

/**
 * GitHub GraphQL `reviewDecision` on the PR list row (REST list omits this).
 * @param {string|null|undefined} decision
 * @returns {{label:string,color:string,bg:string}|null}
 */
export function reviewDecisionListBadge(decision: any) {
  if (!decision || typeof decision !== 'string') return null;
  const d = decision.toUpperCase();
  if (d === 'APPROVED') return reviewsBadge('approved');
  if (d === 'CHANGES_REQUESTED') return reviewsBadge('changes_requested');
  if (d === 'REVIEW_REQUIRED') return reviewsBadge('pending');
  return null;
}

/**
 * Merge queue / branch-protection hints beyond boolean `mergeable`.
 * Skips when `mergeable === false` (Conflicts badge already covers that).
 * @param {{ merge_state_status?: string|null, mergeable_state?: string|null, mergeable?: boolean|null }} pr
 * @returns {{label:string,color:string,bg:string,title?:string}|null}
 */
export function mergePipelineListBadge(pr: any) {
  if (!pr) return null;
  if (pr.mergeable === false) return null;
  const upper = String(pr.merge_state_status || '').toUpperCase();
  const rest = String(pr.mergeable_state || '').toLowerCase();

  if (upper === 'BLOCKED' || rest === 'blocked') {
    return {
      label: 'Blocked',
      color: TOKEN.yellow.text,
      bg: TOKEN.yellow.bg,
      title: 'Merging is blocked (required reviews, checks, or branch protection).',
    };
  }
  if (upper === 'BEHIND' || rest === 'behind') {
    return {
      label: 'Behind',
      color: TOKEN.gray.text,
      bg: TOKEN.gray.bg,
      title: 'Head branch is behind the base branch.',
    };
  }
  if (upper === 'UNSTABLE' || rest === 'unstable') {
    return {
      label: 'Unstable',
      color: TOKEN.yellow.text,
      bg: TOKEN.yellow.bg,
      title: 'Required checks failed or were cancelled.',
    };
  }
  if (pr.mergeable !== true && pr.mergeable !== false) {
    if (upper === 'DIRTY' || rest === 'dirty') {
      return {
        label: 'Conflicted',
        color: TOKEN.red.text,
        bg: TOKEN.red.bg,
        title: 'GitHub reports merge conflicts while mergeability is still computing.',
      };
    }
  }
  return null;
}

/**
 * Tailwind classes + icon hint for a single check-run row. The caller picks
 * the matching lucide-react icon from `iconKey`.
 * @param {{status?:string, conclusion?:string}} chk
 * @returns {{color:string, iconKey:'success'|'failure'|'pending'|'unknown'}}
 */
export function checkRowStyle(chk: any) {
  const status = (chk?.status || '').toLowerCase();
  const concl = (chk?.conclusion || '').toLowerCase();
  if (status && status !== 'completed') {
    return { color: TOKEN.yellow.text, iconKey: 'pending' };
  }
  if (concl === 'success' || concl === 'skipped' || concl === 'neutral') {
    return { color: TOKEN.emerald.text, iconKey: 'success' };
  }
  if (
    concl === 'failure' ||
    concl === 'timed_out' ||
    concl === 'cancelled' ||
    concl === 'action_required'
  ) {
    return { color: TOKEN.red.text, iconKey: 'failure' };
  }
  return { color: TOKEN.gray.text, iconKey: 'unknown' };
}

/**
 * Color class for a review's state label (matches mobile review block).
 * @param {string|null|undefined} state
 */
export function reviewStateColor(state: any) {
  const s = (state || '').toUpperCase();
  if (s === 'APPROVED') return TOKEN.emerald.text;
  if (s === 'CHANGES_REQUESTED') return TOKEN.red.text;
  if (s === 'COMMENTED') return TOKEN.blue.text;
  return TOKEN.gray.text;
}

/** Aligned with server `pr-resolve` conflict detection (`dirty` / `conflicting`). */
const LIST_ROW_CONFLICT_MERGE_STATES = new Set(['dirty', 'conflicting']);

/**
 * True when PR list row fields suggest `POST .../resolve` might spawn a session
 * (merge conflicts, failing checks, or changes requested). Used for UI hints only.
 * @param {Record<string, unknown>} pr
 */
export function prListRowSuggestsResolvableWork(pr: any) {
  if (!pr || String(pr.state || '').toLowerCase() !== 'open') return false;
  if (pr.mergeable === false) return true;
  const ms = String(pr.mergeable_state || '').toLowerCase();
  if (LIST_ROW_CONFLICT_MERGE_STATES.has(ms)) return true;
  if (ms === 'unstable') return true;
  const rollup = pr.check_rollup;
  if (Array.isArray(rollup) && rollup.length > 0) {
    if (summarizeChecks(rollup).overall === 'failure') return true;
  }
  if (String(pr.review_decision || '').toUpperCase() === 'CHANGES_REQUESTED') return true;
  return false;
}

/**
 * When true, the list-row Resolve action is disabled (best-effort: mirrors a
 * clean `no-action-needed` outcome). Unknown / pending mergeability keeps Resolve enabled.
 * @param {Record<string, unknown>} pr
 */
export function prListRowResolveDisabledHeuristic(pr: any) {
  if (!pr || String(pr.state || '').toLowerCase() !== 'open') return true;
  if (prListRowSuggestsResolvableWork(pr)) return false;
  if (pr.mergeable !== true && pr.mergeable !== false) return false;
  const rollup = pr.check_rollup;
  if (Array.isArray(rollup) && rollup.length > 0) {
    const s = summarizeChecks(rollup);
    if (s.overall === 'pending') return false;
  }
  const ms = String(pr.mergeable_state || '').toLowerCase();
  if (!ms || ms === 'unknown') return false;
  return pr.mergeable === true && ms === 'clean';
}

/**
 * Parse an ISO 8601 timestamp to epoch ms, or null if invalid.
 * @param {string|null|undefined} iso
 * @returns {number|null}
 */
function prActivityAtMs(iso: any) {
  if (!iso || typeof iso !== 'string') return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
}

/**
 * Build a single chronological activity feed for the PR detail view by merging
 * lifecycle milestones, reviews, issue comments, and check runs (using
 * completed_at, else started_at). Oldest events first — mirrors the GitHub PR
 * conversation ordering users expect from `/pulls/:id` data already returned by
 * `GET /api/projects/:projectId/pulls/:number`.
 *
 * @param {Record<string, unknown>} pr
 * @param {{ reviews?: unknown[]; comments?: unknown[]; checks?: unknown[] }|null|undefined} detail
 * @returns {Array<Record<string, unknown>>}
 */
export function buildPrActivityTimeline(pr: any, detail: any) {
  /** @type {Array<Record<string, unknown>>} */
  const items: any[] = [];

  const openedMs = prActivityAtMs(pr?.created_at);
  if (openedMs !== null) {
    items.push({
      id: 'lifecycle-opened',
      kind: 'opened',
      at: pr.created_at,
      atMs: openedMs,
      user: pr.user ?? null,
    });
  }

  const reviews = Array.isArray(detail?.reviews) ? detail.reviews : [];
  for (const r of reviews) {
    const raw = /** @type {Record<string, unknown>} */ r;
    const ms = prActivityAtMs(/** @type {string|undefined} */ raw.submitted_at);
    if (ms === null) continue;
    const rid = raw.id != null ? String(raw.id) : `r-${ms}`;
    items.push({
      id: `review-${rid}`,
      kind: 'review',
      at: raw.submitted_at,
      atMs: ms,
      review: raw,
    });
  }

  const comments = Array.isArray(detail?.comments) ? detail.comments : [];
  for (const c of comments) {
    const raw = /** @type {Record<string, unknown>} */ c;
    const ms = prActivityAtMs(/** @type {string|undefined} */ raw.created_at);
    if (ms === null) continue;
    const cid = raw.id != null ? String(raw.id) : `c-${ms}`;
    items.push({
      id: `comment-${cid}`,
      kind: 'comment',
      at: raw.created_at,
      atMs: ms,
      comment: raw,
    });
  }

  // CI check runs are intentionally excluded from this timeline — the dedicated
  // "CI Checks" section already surfaces them, so echoing them here is redundant.

  if (pr?.merged_at) {
    const m = prActivityAtMs(pr.merged_at);
    if (m !== null) {
      items.push({
        id: 'lifecycle-merged',
        kind: 'merged',
        at: pr.merged_at,
        atMs: m,
      });
    }
  } else if (pr?.closed_at) {
    const c = prActivityAtMs(pr.closed_at);
    if (c !== null) {
      items.push({
        id: 'lifecycle-closed',
        kind: 'closed',
        at: pr.closed_at,
        atMs: c,
      });
    }
  }

  const kindOrder = { opened: 0, comment: 1, review: 2, merged: 3, closed: 4 } as Record<
    string,
    any
  >;
  items.sort((a: any, b: any) => {
    const ams = /** @type {number} */ a.atMs;
    const bms = /** @type {number} */ b.atMs;
    if (ams !== bms) return ams - bms;
    const ak = /** @type {string} */ a.kind;
    const bk = /** @type {string} */ b.kind;
    return (kindOrder[ak] ?? 9) - (kindOrder[bk] ?? 9);
  });

  return items;
}
