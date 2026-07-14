/** Return true only when a board event belongs to the visible project. */
export function kanbanEventTargetsProject(
  eventProjectId: unknown,
  activeProjectId: unknown,
): eventProjectId is string {
  return (
    typeof eventProjectId === 'string' &&
    eventProjectId.length > 0 &&
    typeof activeProjectId === 'string' &&
    activeProjectId.length > 0 &&
    eventProjectId === activeProjectId
  );
}

/** Preserve every project touched during one coalesced refresh window. */
export function addKanbanRefreshProject(
  pending: ReadonlySet<string>,
  projectId: unknown,
): Set<string> {
  if (typeof projectId !== 'string' || projectId.length === 0) return new Set(pending);
  const next = new Set(pending);
  next.add(projectId);
  return next;
}

/** Coalesce refresh requests emitted by a burst of related WebSocket events. */
export function createRefreshScheduler(onRefresh: () => void, delayMs = 100) {
  let timer: ReturnType<typeof setTimeout> | null = null;

  const schedule = () => {
    if (timer !== null) return;
    timer = setTimeout(() => {
      timer = null;
      onRefresh();
    }, delayMs);
  };

  const dispose = () => {
    if (timer === null) return;
    clearTimeout(timer);
    timer = null;
  };

  return { schedule, dispose };
}
