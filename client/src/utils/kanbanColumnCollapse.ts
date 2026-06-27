/** localStorage key prefix for collapsed kanban columns, scoped per project. */
export function kanbanCollapsedColumnsKey(projectId: string): string {
  return `kanbanCollapsedColumns:${projectId}`;
}

export function readCollapsedColumnIds(projectId: string | null | undefined): Set<string> {
  if (!projectId) return new Set();
  try {
    const raw = localStorage.getItem(kanbanCollapsedColumnsKey(projectId));
    if (!raw) return new Set();
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((id) => typeof id === 'string' && id.length > 0));
  } catch {
    return new Set();
  }
}

export function writeCollapsedColumnIds(
  projectId: string | null | undefined,
  collapsedIds: Set<string>,
): void {
  if (!projectId) return;
  try {
    const key = kanbanCollapsedColumnsKey(projectId);
    if (collapsedIds.size === 0) {
      localStorage.removeItem(key);
      return;
    }
    localStorage.setItem(key, JSON.stringify([...collapsedIds]));
  } catch {
    // Best-effort persistence.
  }
}

/** Drop stale ids after columns are deleted or the board is reshaped. */
export function pruneCollapsedColumnIds(
  collapsedIds: Set<string>,
  validColumnIds: Iterable<string>,
): Set<string> {
  const valid = new Set(validColumnIds);
  const next = new Set([...collapsedIds].filter((id) => valid.has(id)));
  return next.size === collapsedIds.size ? collapsedIds : next;
}
