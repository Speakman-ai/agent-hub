// Pure formatting helpers for the mobile PR viewer.
// Extracted so they can be unit-tested without rendering React Native.

import { colors } from '../theme/colors';

/**
 * Extract the numeric ID from a PR URL.
 * @param {string} prUrl
 * @returns {string|null}
 */
export function prNumberFromUrl(prUrl) {
  if (!prUrl || typeof prUrl !== 'string') return null;
  const m = prUrl.match(/\/pull\/(\d+)(?:$|[?#/])/);
  return m ? m[1] : null;
}

/**
 * Short human-readable relative time, e.g. "2m ago", "3h ago", "4d ago".
 * Falls back to locale date for anything older than ~30 days.
 * @param {string|null|undefined} iso
 */
export function relativePrTime(iso) {
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
 * Summarize diff stats into a compact "+10 -2 in 4 files" string.
 * @param {{additions?: number, deletions?: number, changed_files?: number}} pr
 */
export function diffSummary(pr) {
  if (!pr) return '';
  const adds = Number.isFinite(pr.additions) ? pr.additions : null;
  const dels = Number.isFinite(pr.deletions) ? pr.deletions : null;
  const files = Number.isFinite(pr.changed_files) ? pr.changed_files : null;
  const parts = [];
  if (adds !== null) parts.push(`+${adds}`);
  if (dels !== null) parts.push(`-${dels}`);
  if (files !== null) parts.push(`${files} file${files === 1 ? '' : 's'}`);
  return parts.join(' · ');
}

/**
 * Pick a status label + color for a PR given its state + draft flag.
 * @param {{state?: string, draft?: boolean, merged_at?: string|null}} pr
 */
export function prStateBadge(pr) {
  if (!pr) return { label: 'unknown', color: colors.gray500, bg: colors.gray700_40 };
  if (pr.merged_at) return { label: 'merged', color: colors.purple400, bg: colors.purple900_40 };
  if (pr.draft) return { label: 'draft', color: colors.gray400, bg: colors.gray700_40 };
  const s = (pr.state || '').toLowerCase();
  if (s === 'open') return { label: 'open', color: colors.emerald400, bg: colors.emerald900_40 };
  if (s === 'closed') return { label: 'closed', color: colors.red400, bg: colors.red900_50 };
  return { label: s || 'unknown', color: colors.gray500, bg: colors.gray700_40 };
}

/**
 * Decide whether the "Mergeable" / "Conflicts" badge should render.
 * Mirrors the mobile badge guard: only show when `mergeable` is a real
 * boolean. `null` means GitHub is still computing — suppress the badge
 * rather than showing a misleading "Conflicts".
 * @param {boolean|null|undefined} mergeable
 * @returns {{show:boolean,label?:string,good?:boolean}}
 */
export function mergeableBadge(mergeable) {
  if (typeof mergeable !== 'boolean') return { show: false };
  return { show: true, label: mergeable ? 'Mergeable' : 'Conflicts', good: mergeable };
}

/**
 * Aggregate check-runs into pass/fail/pending counts + an overall badge.
 * Matches the GitHub "Checks" strip logic:
 *   - any `failure` or `timed_out` or `cancelled` or `action_required` => failure
 *   - else any `status` != 'completed' => in_progress
 *   - else all success/neutral/skipped => success
 *   - else mixed => neutral
 * @param {Array<{status?:string, conclusion?:string}>} checks
 */
export function summarizeChecks(checks) {
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
  let overall;
  if (total === 0) overall = 'none';
  else if (failure > 0) overall = 'failure';
  else if (pending > 0) overall = 'pending';
  else overall = 'success';
  return { total, success, failure, pending, neutral, overall };
}

/**
 * Badge color + label for aggregated check runs.
 */
export function checksBadge(summary) {
  if (!summary || summary.overall === 'none') {
    return { label: 'No checks', color: colors.gray500, bg: colors.gray700_40 };
  }
  if (summary.overall === 'success') {
    return {
      label: `${summary.success}/${summary.total} passed`,
      color: colors.emerald400,
      bg: colors.emerald900_40,
    };
  }
  if (summary.overall === 'failure') {
    return {
      label: `${summary.failure}/${summary.total} failing`,
      color: colors.red400,
      bg: colors.red900_50,
    };
  }
  return {
    label: `${summary.pending}/${summary.total} running`,
    color: colors.yellow400,
    bg: colors.yellow900_50,
  };
}

/**
 * Derive an overall review status from a list of reviews.
 * Later reviews by the same user supersede earlier ones.
 * @param {Array<{user?:string|null, state?:string, submitted_at?:string|null}>} reviews
 * @returns {'approved'|'changes_requested'|'commented'|'pending'|'none'}
 */
export function summarizeReviews(reviews) {
  const arr = Array.isArray(reviews) ? reviews : [];
  if (arr.length === 0) return 'none';
  // Keep only the latest review per user (ignore COMMENTED when later APPROVAL exists)
  const byUser = new Map();
  const sorted = [...arr].sort((a, b) => {
    const ta = a.submitted_at ? Date.parse(a.submitted_at) : 0;
    const tb = b.submitted_at ? Date.parse(b.submitted_at) : 0;
    return ta - tb;
  });
  for (const r of sorted) {
    const key = r.user || '__anon__';
    const state = (r.state || '').toUpperCase();
    // COMMENTED doesn't supersede an existing APPROVED/CHANGES_REQUESTED
    const prev = byUser.get(key);
    if (state === 'COMMENTED' && prev && prev !== 'COMMENTED') continue;
    byUser.set(key, state);
  }
  const states = [...byUser.values()];
  if (states.some((s) => s === 'CHANGES_REQUESTED')) return 'changes_requested';
  if (states.some((s) => s === 'APPROVED')) return 'approved';
  if (states.some((s) => s === 'COMMENTED')) return 'commented';
  if (states.some((s) => s === 'PENDING')) return 'pending';
  return 'none';
}

/**
 * Badge for aggregated review state.
 */
export function reviewsBadge(state) {
  switch (state) {
    case 'approved':
      return { label: 'Approved', color: colors.emerald400, bg: colors.emerald900_40 };
    case 'changes_requested':
      return { label: 'Changes requested', color: colors.red400, bg: colors.red900_50 };
    case 'commented':
      return { label: 'Commented', color: colors.blue400, bg: colors.blue900_40 };
    case 'pending':
      return { label: 'Pending review', color: colors.yellow400, bg: colors.yellow900_50 };
    default:
      return { label: 'No reviews', color: colors.gray500, bg: colors.gray700_40 };
  }
}

/**
 * @param {string|null|undefined} decision
 * @returns {{label:string,color:string,bg:string}|null}
 */
export function reviewDecisionListBadge(decision) {
  if (!decision || typeof decision !== 'string') return null;
  const d = decision.toUpperCase();
  if (d === 'APPROVED') return reviewsBadge('approved');
  if (d === 'CHANGES_REQUESTED') return reviewsBadge('changes_requested');
  if (d === 'REVIEW_REQUIRED') return reviewsBadge('pending');
  return null;
}

/**
 * @param {{ merge_state_status?: string|null, mergeable_state?: string|null, mergeable?: boolean|null }} pr
 * @returns {{label:string,color:string,bg:string,title?:string}|null}
 */
export function mergePipelineListBadge(pr) {
  if (!pr) return null;
  if (pr.mergeable === false) return null;
  const upper = String(pr.merge_state_status || '').toUpperCase();
  const rest = String(pr.mergeable_state || '').toLowerCase();
  if (upper === 'BLOCKED' || rest === 'blocked') {
    return {
      label: 'Blocked',
      color: colors.yellow400,
      bg: colors.yellow900_50,
      title: 'Merging is blocked (required reviews, checks, or branch protection).',
    };
  }
  if (upper === 'BEHIND' || rest === 'behind') {
    return {
      label: 'Behind',
      color: colors.gray400,
      bg: colors.gray700_40,
      title: 'Head branch is behind the base branch.',
    };
  }
  if (upper === 'UNSTABLE' || rest === 'unstable') {
    return {
      label: 'Unstable',
      color: colors.yellow400,
      bg: colors.yellow900_50,
      title: 'Required checks failed or were cancelled.',
    };
  }
  if (pr.mergeable !== true && pr.mergeable !== false) {
    if (upper === 'DIRTY' || rest === 'dirty') {
      return {
        label: 'Conflicted',
        color: colors.red400,
        bg: colors.red900_50,
        title: 'GitHub reports merge conflicts while mergeability is still computing.',
      };
    }
  }
  return null;
}

/** Aligned with server `pr-resolve` conflict detection (`dirty` / `conflicting`). */
const LIST_ROW_CONFLICT_MERGE_STATES = new Set(['dirty', 'conflicting']);

/**
 * True when PR list row fields suggest `POST .../resolve` might spawn a session.
 * @param {Record<string, unknown>} pr
 */
export function prListRowSuggestsResolvableWork(pr) {
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
 * When true, grey out list-row Resolve — best-effort clean PR detection.
 * @param {Record<string, unknown>} pr
 */
export function prListRowResolveDisabledHeuristic(pr) {
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
