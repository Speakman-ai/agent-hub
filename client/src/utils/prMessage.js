/**
 * Helpers for rendering system-role chat messages about PR lifecycle events.
 *
 * The server stores `messages.metadata` as a stringified JSON blob. For the
 * "PR created" marker (written in server/auto-git.ts broadcastAndMove) the
 * shape is:
 *
 *   { kind: 'pr_created', prUrl, prNumber, commitSha, commitTitle,
 *     cardId, cardTitle }
 *
 * cardId/cardTitle are null when the PR was created from an ad-hoc session
 * with no linked kanban card. Malformed metadata (unparseable JSON, wrong
 * kind, missing required fields) is treated as a non-match so the component
 * can fall back to a generic system-message render instead of crashing.
 */

export function parsePrCreatedMetadata(metadataString) {
  if (metadataString == null) return null;
  let parsed;
  try {
    parsed = typeof metadataString === 'string' ? JSON.parse(metadataString) : metadataString;
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  if (parsed.kind !== 'pr_created') return null;
  if (typeof parsed.prUrl !== 'string' || parsed.prUrl.length === 0) return null;
  return {
    prUrl: parsed.prUrl,
    prNumber: typeof parsed.prNumber === 'number' ? parsed.prNumber : null,
    commitSha: typeof parsed.commitSha === 'string' ? parsed.commitSha : '',
    commitTitle: typeof parsed.commitTitle === 'string' ? parsed.commitTitle : '',
    cardId: typeof parsed.cardId === 'string' ? parsed.cardId : null,
    cardTitle: typeof parsed.cardTitle === 'string' ? parsed.cardTitle : null,
  };
}

/**
 * Truncates a git SHA for display (first 7 chars matches GitHub's convention).
 * Returns '' for empty/invalid input so templates can safely render it.
 */
export function shortSha(sha) {
  if (typeof sha !== 'string' || sha.length === 0) return '';
  return sha.substring(0, 7);
}

/**
 * Parse the `pr_failed` system-message metadata produced by
 * `persistAndBroadcastPrFailure` in `server/auto-git.ts`. Shape:
 *
 *   { kind: 'pr_failed', code, error, branch, cardId, cardTitle, agentName }
 *
 * `code` is one of 'commit_failed' | 'push_failed' | 'pr_failed' |
 * 'rebase_conflict'. (`nothing_to_publish` is a benign no-op and is never
 * persisted.) Malformed metadata returns null so the caller can fall back to a
 * generic system-message render.
 */
export function parsePrFailedMetadata(metadataString) {
  if (metadataString == null) return null;
  let parsed;
  try {
    parsed = typeof metadataString === 'string' ? JSON.parse(metadataString) : metadataString;
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  if (parsed.kind !== 'pr_failed') return null;
  const allowedCodes = new Set(['commit_failed', 'push_failed', 'pr_failed', 'rebase_conflict']);
  if (typeof parsed.code !== 'string' || !allowedCodes.has(parsed.code)) return null;
  if (typeof parsed.error !== 'string') return null;
  return {
    code: parsed.code,
    error: parsed.error,
    branch: typeof parsed.branch === 'string' ? parsed.branch : null,
    cardId: typeof parsed.cardId === 'string' ? parsed.cardId : null,
    cardTitle: typeof parsed.cardTitle === 'string' ? parsed.cardTitle : null,
    agentName: typeof parsed.agentName === 'string' ? parsed.agentName : null,
  };
}

/**
 * Short human-friendly label for a pr_failed `code`. Used in toasts and chat
 * callouts so users see "Push rejected" rather than `push_failed`.
 */
export function describePrFailureCode(code) {
  switch (code) {
    case 'push_failed':
      return 'Push rejected';
    case 'commit_failed':
      return 'Commit failed';
    case 'pr_failed':
      return 'PR creation failed';
    case 'rebase_conflict':
      return 'Rebase conflict';
    default:
      return 'Auto-PR failed';
  }
}
