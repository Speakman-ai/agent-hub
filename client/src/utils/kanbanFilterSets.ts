/** Snapshot of the kanban board sidebar filters. */
export type KanbanFilterSetSnapshot = {
  searchQuery: string;
  epicIds: string[];
  labels: string[];
  userIds: string[];
};

export type KanbanFilterSet = KanbanFilterSetSnapshot & {
  id: string;
  name: string;
  updatedAt: string;
};

export function kanbanFilterSetsKey(projectId: string): string {
  return `kanbanFilterSets:${projectId}`;
}

export function readFilterSets(projectId: string | null | undefined): KanbanFilterSet[] {
  if (!projectId) return [];
  try {
    const raw = localStorage.getItem(kanbanFilterSetsKey(projectId));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (row) =>
          row &&
          typeof row.id === 'string' &&
          typeof row.name === 'string' &&
          typeof row.searchQuery === 'string' &&
          Array.isArray(row.epicIds) &&
          Array.isArray(row.labels) &&
          (row.userIds === undefined || Array.isArray(row.userIds)),
      )
      .map((row) => ({
        id: row.id,
        name: row.name,
        searchQuery: row.searchQuery,
        epicIds: row.epicIds.filter((id: unknown) => typeof id === 'string'),
        labels: row.labels.filter((label: unknown) => typeof label === 'string'),
        userIds: Array.isArray(row.userIds)
          ? row.userIds.filter((id: unknown) => typeof id === 'string')
          : [],
        updatedAt: typeof row.updatedAt === 'string' ? row.updatedAt : new Date(0).toISOString(),
      }));
  } catch {
    return [];
  }
}

export function writeFilterSets(
  projectId: string | null | undefined,
  sets: KanbanFilterSet[],
): void {
  if (!projectId) return;
  try {
    const key = kanbanFilterSetsKey(projectId);
    if (sets.length === 0) {
      localStorage.removeItem(key);
      return;
    }
    localStorage.setItem(key, JSON.stringify(sets));
  } catch {
    // Best-effort persistence.
  }
}

export function snapshotFromState(
  searchQuery: string,
  epicIds: Set<string>,
  labels: Set<string>,
  userIds: Set<string> = new Set(),
): KanbanFilterSetSnapshot {
  return {
    searchQuery: searchQuery.trim(),
    epicIds: [...epicIds],
    labels: [...labels],
    userIds: [...userIds],
  };
}

export function applySnapshot(snapshot: KanbanFilterSetSnapshot): {
  searchQuery: string;
  epicIds: Set<string>;
  labels: Set<string>;
  userIds: Set<string>;
} {
  return {
    searchQuery: snapshot.searchQuery,
    epicIds: new Set(snapshot.epicIds),
    labels: new Set(snapshot.labels),
    userIds: new Set(snapshot.userIds ?? []),
  };
}

export function isEmptySnapshot(snapshot: KanbanFilterSetSnapshot): boolean {
  return (
    !snapshot.searchQuery.trim() &&
    snapshot.epicIds.length === 0 &&
    snapshot.labels.length === 0 &&
    snapshot.userIds.length === 0
  );
}

export function filterSetsEqual(a: KanbanFilterSetSnapshot, b: KanbanFilterSetSnapshot): boolean {
  if (a.searchQuery.trim() !== b.searchQuery.trim()) return false;
  const epicA = [...a.epicIds].sort();
  const epicB = [...b.epicIds].sort();
  if (epicA.length !== epicB.length || epicA.some((id, i) => id !== epicB[i])) return false;
  const labelA = [...a.labels].sort();
  const labelB = [...b.labels].sort();
  if (labelA.length !== labelB.length || labelA.some((label, i) => label !== labelB[i])) {
    return false;
  }
  const userA = [...a.userIds].sort();
  const userB = [...b.userIds].sort();
  return userA.length === userB.length && userA.every((id, i) => id === userB[i]);
}

function newFilterSetId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `filter-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

/** Save or update a named filter set for a project. Same name (case-insensitive) updates in place. */
export function saveFilterSet(
  projectId: string,
  name: string,
  snapshot: KanbanFilterSetSnapshot,
): KanbanFilterSet[] {
  const trimmedName = name.trim();
  if (!trimmedName) {
    throw new Error('Filter name is required');
  }
  if (isEmptySnapshot(snapshot)) {
    throw new Error('Add at least one filter before saving');
  }

  const existing = readFilterSets(projectId);
  const now = new Date().toISOString();
  const normalized = trimmedName.toLowerCase();
  const matchIdx = existing.findIndex((set) => set.name.toLowerCase() === normalized);

  let next: KanbanFilterSet[];
  if (matchIdx >= 0) {
    next = existing.map((set, idx) =>
      idx === matchIdx
        ? {
            ...set,
            name: trimmedName,
            searchQuery: snapshot.searchQuery,
            epicIds: [...snapshot.epicIds],
            labels: [...snapshot.labels],
            userIds: [...snapshot.userIds],
            updatedAt: now,
          }
        : set,
    );
  } else {
    next = [
      ...existing,
      {
        id: newFilterSetId(),
        name: trimmedName,
        searchQuery: snapshot.searchQuery,
        epicIds: [...snapshot.epicIds],
        labels: [...snapshot.labels],
        userIds: [...snapshot.userIds],
        updatedAt: now,
      },
    ];
  }

  writeFilterSets(projectId, next);
  return next;
}

export function deleteFilterSet(projectId: string, id: string): KanbanFilterSet[] {
  const next = readFilterSets(projectId).filter((set) => set.id !== id);
  writeFilterSets(projectId, next);
  return next;
}

export function findMatchingFilterSet(
  sets: KanbanFilterSet[],
  snapshot: KanbanFilterSetSnapshot,
): KanbanFilterSet | null {
  return sets.find((set) => filterSetsEqual(set, snapshot)) ?? null;
}
