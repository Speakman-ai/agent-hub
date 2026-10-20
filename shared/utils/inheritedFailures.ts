/**
 * Display helpers for a Finalize run that passed with inherited failures:
 * its only failed instances were already failing on the default branch, so it
 * skipped the fix turn and does not block push/merge. The server stores the
 * summary as JSON on `finalize_runs.inherited_failures`.
 */

export interface InheritedFailuresSummary {
  count: number;
  cardId: string | null;
}

/** Read the summary off a run row (JSON string or parsed object). */
export function readInheritedFailures(run: unknown): InheritedFailuresSummary | null {
  if (!run || typeof run !== 'object') return null;
  let raw: unknown = (run as { inherited_failures?: unknown }).inherited_failures;
  if (typeof raw === 'string') {
    try {
      raw = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!raw || typeof raw !== 'object') return null;
  const { count, cardId } = raw as { count?: unknown; cardId?: unknown };
  if (typeof count !== 'number' || count <= 0) return null;
  return { count, cardId: typeof cardId === 'string' && cardId ? cardId : null };
}

/** `Tested (inherited failures: N)`, or null when the run has none. */
export function inheritedFailuresLabel(run: unknown): string | null {
  const summary = readInheritedFailures(run);
  return summary ? `Tested (inherited failures: ${summary.count})` : null;
}

/** Board deep link to the breakage card, or null when none was opened. */
export function inheritedFailuresCardPath(projectId: string, run: unknown): string | null {
  const summary = readInheritedFailures(run);
  if (!summary?.cardId || !projectId) return null;
  return `/projects/${encodeURIComponent(projectId)}/board?card=${encodeURIComponent(summary.cardId)}`;
}
