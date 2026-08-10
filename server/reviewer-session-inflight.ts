import type { Project, SessionRow } from './types.js';

const REVIEW_PR_TITLE_RE = /^Review: PR #(\d+)\b/i;

export function parsePrNumberFromReviewSessionTitle(
  name: string | null | undefined,
): number | null {
  const m = (name || '').trim().match(REVIEW_PR_TITLE_RE);
  if (!m) return null;
  const n = Number.parseInt(m[1], 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Returns a reviewer-agent session id when that session targets `prNumber` and
 * the CLI process is still running (`activeProcesses`).
 */
export function findInFlightReviewerSessionId(
  project: Project,
  prNumber: number,
  listSessionsForAgent: (agentId: string) => SessionRow[],
  activeProcesses: Map<string, import('./active-chat-process.js').ActiveChatProcess>,
): string | null {
  const reviewerIds = (project.agents || []).filter((a) => a.role === 'reviewer').map((a) => a.id);
  for (const reviewerId of reviewerIds) {
    for (const s of listSessionsForAgent(reviewerId)) {
      if (parsePrNumberFromReviewSessionTitle(s.name) !== prNumber) continue;
      if (activeProcesses.has(s.id)) return s.id;
    }
  }
  return null;
}
