/**
 * Confirm-dialog copy and diff sizing for the session Discard action, shared
 * by web and mobile so both surfaces warn with the same words.
 *
 * The diff comes from GET /api/sessions/:id/changes (the same delta the
 * Changes pane shows: committed + uncommitted + untracked vs base).
 */

export interface DiscardDiffSummary {
  files: number;
  additions: number;
  deletions: number;
  /** The server capped the file list, so the counts are a lower bound. */
  truncated: boolean;
}

interface ChangedFileLike {
  additions?: unknown;
  deletions?: unknown;
}

function count(n: unknown): number {
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

export function summarizeDiscardDiff(changes: unknown): DiscardDiffSummary | null {
  const files = (changes as { files?: unknown } | null)?.files;
  if (!Array.isArray(files)) return null;
  let additions = 0;
  let deletions = 0;
  for (const f of files as ChangedFileLike[]) {
    additions += count(f?.additions);
    deletions += count(f?.deletions);
  }
  return {
    files: files.length,
    additions,
    deletions,
    truncated: (changes as { truncated?: unknown }).truncated === true,
  };
}

/** "3 files (+120 -4)"; `null` when the diff could not be loaded. */
export function formatDiscardDiffSize(summary: DiscardDiffSummary | null): string | null {
  if (!summary) return null;
  const plus = summary.truncated ? '+' : '';
  const noun = summary.files === 1 && !summary.truncated ? 'file' : 'files';
  return `${summary.files}${plus} ${noun} (+${summary.additions} -${summary.deletions})`;
}

export const DISCARD_CONFIRM_TITLE = 'Discard session changes?';

export function discardConfirmMessage(summary: DiscardDiffSummary | null): string {
  const size = formatDiscardDiffSize(summary);
  const what =
    size === null
      ? 'The size of the diff could not be loaded.'
      : summary && summary.files === 0
        ? 'No changed files against the base branch.'
        : `This throws away ${size}.`;
  return `${what} The worktree is reset to its base branch and untracked files are deleted. This cannot be undone.`;
}

/**
 * Why Discard is unavailable, or null when it can run. The server refuses
 * while a Finalize run is unfinished (including one parked at ready_to_push),
 * so the button disables up front instead of round-tripping a 409.
 */
export function discardBlockedReason(args: {
  sessionId?: string | null;
  finalizeInFlight?: boolean;
  readyToPush?: boolean;
}): string | null {
  if (!args.sessionId) return 'No session selected';
  if (args.finalizeInFlight) return 'Stop Finalize before discarding';
  if (args.readyToPush) return 'Finalize validated this branch; push it or re-run Finalize first';
  return null;
}
