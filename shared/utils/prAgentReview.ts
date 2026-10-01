// Agent review progress for a PR summary. The server sets
// `agent_review_requested` when it dispatches the Reviewer session and clears
// it when that session's turn ends, so the flag means "review running now".

export interface PrAgentReviewFields {
  state?: string | null;
  agent_review_requested?: boolean | null;
  agent_review_started_at?: string | null;
}

export interface PrAgentReviewProgress {
  active: boolean;
  /** Short chip text, e.g. "Reviewing". */
  label: string;
  /** Longer text, e.g. "Agent review in progress · started 3m ago". */
  detail: string;
}

function elapsed(startedAt: string | null | undefined, now: number): string | null {
  if (!startedAt) return null;
  const t = Date.parse(startedAt);
  if (!Number.isFinite(t)) return null;
  const sec = Math.max(0, Math.floor((now - t) / 1000));
  if (sec < 60) return 'just now';
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  return `${Math.floor(min / 60)}h ago`;
}

/** Returns null when no agent review is running on an open PR. */
export function prAgentReviewProgress(
  pr: PrAgentReviewFields | null | undefined,
  now: number = Date.now(),
): PrAgentReviewProgress | null {
  if (!pr || pr.agent_review_requested !== true) return null;
  if (pr.state && pr.state.toLowerCase() !== 'open') return null;
  const since = elapsed(pr.agent_review_started_at, now);
  return {
    active: true,
    label: 'Reviewing',
    detail: since ? `Agent review in progress · started ${since}` : 'Agent review in progress',
  };
}
