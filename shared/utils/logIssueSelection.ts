/**
 * Shared state math for multi-select batch triage on the Logs Issues page.
 *
 * Kept transport-free and UI-free so web and mobile drive the same selection
 * and post-batch list reconciliation. Selection is an ordered id list rather
 * than a Set so it survives React state comparison and serializes in tests.
 */

export type LogIssueStatus = 'open' | 'resolved' | 'ignored';
export type LogIssueBulkAction = 'resolve' | 'ignore' | 'reopen';

/** Lifecycle status each batch action writes. */
export const BULK_ACTION_STATUS: Record<LogIssueBulkAction, LogIssueStatus> = {
  resolve: 'resolved',
  ignore: 'ignored',
  reopen: 'open',
};

export const BULK_ACTION_LABEL: Record<LogIssueBulkAction, string> = {
  resolve: 'Resolve',
  ignore: 'Ignore',
  reopen: 'Reopen',
};

/** Add or remove one id, preserving selection order. */
export function toggleSelectedId(selected: readonly string[], id: string): string[] {
  return selected.includes(id) ? selected.filter((s) => s !== id) : [...selected, id];
}

/**
 * Drop ids that are no longer on screen. A status-tab switch or a reload can
 * retire rows the user had ticked; keeping those ids would silently transition
 * issues the user can no longer see.
 */
export function pruneSelection(
  selected: readonly string[],
  visibleIds: readonly string[],
): string[] {
  const visible = new Set(visibleIds);
  return selected.filter((id) => visible.has(id));
}

/** True when every visible row is ticked (false for an empty list). */
export function allVisibleSelected(
  selected: readonly string[],
  visibleIds: readonly string[],
): boolean {
  if (visibleIds.length === 0) return false;
  const chosen = new Set(selected);
  return visibleIds.every((id) => chosen.has(id));
}

/** Header checkbox: select every visible row, or clear the selection entirely. */
export function toggleSelectAll(
  selected: readonly string[],
  visibleIds: readonly string[],
): string[] {
  if (allVisibleSelected(selected, visibleIds)) return [];
  return [...visibleIds];
}

/**
 * Clear the ids a finished request actually submitted, keeping anything the
 * user ticked while it was in flight. Resetting the whole selection instead
 * would silently drop those rows: they were never sent, so they were never
 * transitioned, and the user would be left believing they had been.
 */
export function clearSubmittedIds(
  selected: readonly string[],
  submitted: readonly string[],
): string[] {
  const sent = new Set(submitted);
  return selected.filter((id) => !sent.has(id));
}

/**
 * Offer a batch action only when it would change something: a selection that is
 * already entirely `resolved` gets no Resolve button, so the toolbar never
 * advertises a no-op request.
 */
export function bulkActionAvailable(
  selectedStatuses: readonly LogIssueStatus[],
  action: LogIssueBulkAction,
): boolean {
  if (selectedStatuses.length === 0) return false;
  return selectedStatuses.some((status) => status !== BULK_ACTION_STATUS[action]);
}

/** Statuses of the currently selected rows, skipping ids that left the list. */
export function selectedStatuses<T extends { id: string; status: LogIssueStatus }>(
  issues: readonly T[],
  selected: readonly string[],
): LogIssueStatus[] {
  const chosen = new Set(selected);
  return issues.filter((issue) => chosen.has(issue.id)).map((issue) => issue.status);
}

/**
 * Merge a batch result into the visible list. On a filtered tab a row whose new
 * status no longer matches the tab is removed — otherwise a batch-resolved issue
 * would linger under `Open` with a stale badge. On the `All` tab
 * (`statusFilter === ''`) rows are updated in place.
 */
export function applyBulkUpdateToList<T extends { id: string; status: LogIssueStatus }>(
  issues: readonly T[],
  updated: ReadonlyArray<Partial<T> & { id: string }>,
  statusFilter: string,
): T[] {
  if (updated.length === 0) return [...issues];
  const byId = new Map(updated.map((row) => [row.id, row]));
  const result: T[] = [];
  for (const issue of issues) {
    const patch = byId.get(issue.id);
    if (!patch) {
      result.push(issue);
      continue;
    }
    const merged = { ...issue, ...patch };
    if (statusFilter && merged.status !== statusFilter) continue;
    result.push(merged);
  }
  return result;
}

/**
 * Toast copy for a finished batch. `notFound` ids are surfaced rather than
 * swallowed: they mean the user's selection had gone stale.
 */
export function bulkResultMessage(
  action: LogIssueBulkAction,
  updatedCount: number,
  notFoundCount = 0,
): string {
  const verb = BULK_ACTION_STATUS[action] === 'open' ? 'reopened' : `${BULK_ACTION_STATUS[action]}`;
  const noun = updatedCount === 1 ? 'issue' : 'issues';
  const base = `${updatedCount} ${noun} ${verb}`;
  return notFoundCount > 0 ? `${base} · ${notFoundCount} no longer available` : base;
}
