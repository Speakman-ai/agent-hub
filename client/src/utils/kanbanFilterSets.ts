/**
 * Snapshot of a saved kanban board "view" — every sidebar filter plus the
 * board layout (which columns are collapsed). Named *FilterSet for historical
 * reasons (and to keep the localStorage key stable); the user-facing concept
 * is a "view".
 */
export type KanbanFilterSetSnapshot = {
  searchQuery: string;
  labelSearch?: string;
  userSearch?: string;
  epicIds: string[];
  labels: string[];
  userIds: string[];
  /** Ids of columns collapsed on the board when the view was saved. */
  collapsedColumnIds?: string[];
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
          (row.userIds === undefined || Array.isArray(row.userIds)) &&
          (row.collapsedColumnIds === undefined || Array.isArray(row.collapsedColumnIds)),
      )
      .map((row) => ({
        id: row.id,
        name: row.name,
        searchQuery: row.searchQuery,
        labelSearch: typeof row.labelSearch === 'string' ? row.labelSearch : '',
        userSearch: typeof row.userSearch === 'string' ? row.userSearch : '',
        epicIds: row.epicIds.filter((id: unknown) => typeof id === 'string'),
        labels: row.labels.filter((label: unknown) => typeof label === 'string'),
        userIds: Array.isArray(row.userIds)
          ? row.userIds.filter((id: unknown) => typeof id === 'string')
          : [],
        collapsedColumnIds: Array.isArray(row.collapsedColumnIds)
          ? row.collapsedColumnIds.filter((id: unknown) => typeof id === 'string')
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
  labelSearch: string,
  userSearch: string,
  epicIds: Set<string>,
  labels: Set<string>,
  userIds: Set<string> = new Set(),
  collapsedColumnIds: Set<string> = new Set(),
): KanbanFilterSetSnapshot {
  return {
    searchQuery: searchQuery.trim(),
    labelSearch: labelSearch.trim(),
    userSearch: userSearch.trim(),
    epicIds: [...epicIds],
    labels: [...labels],
    userIds: [...userIds],
    collapsedColumnIds: [...collapsedColumnIds],
  };
}

export function applySnapshot(snapshot: KanbanFilterSetSnapshot): {
  searchQuery: string;
  labelSearch: string;
  userSearch: string;
  epicIds: Set<string>;
  labels: Set<string>;
  userIds: Set<string>;
  collapsedColumnIds: Set<string>;
} {
  return {
    searchQuery: snapshot.searchQuery,
    labelSearch: snapshot.labelSearch ?? '',
    userSearch: snapshot.userSearch ?? '',
    epicIds: new Set(snapshot.epicIds),
    labels: new Set(snapshot.labels),
    userIds: new Set(snapshot.userIds ?? []),
    collapsedColumnIds: new Set(snapshot.collapsedColumnIds ?? []),
  };
}

export function isEmptySnapshot(snapshot: KanbanFilterSetSnapshot): boolean {
  return (
    !snapshot.searchQuery.trim() &&
    !(snapshot.labelSearch ?? '').trim() &&
    !(snapshot.userSearch ?? '').trim() &&
    snapshot.epicIds.length === 0 &&
    snapshot.labels.length === 0 &&
    snapshot.userIds.length === 0 &&
    (snapshot.collapsedColumnIds ?? []).length === 0
  );
}

export function filterSetsEqual(a: KanbanFilterSetSnapshot, b: KanbanFilterSetSnapshot): boolean {
  if (a.searchQuery.trim() !== b.searchQuery.trim()) return false;
  if ((a.labelSearch ?? '').trim() !== (b.labelSearch ?? '').trim()) return false;
  if ((a.userSearch ?? '').trim() !== (b.userSearch ?? '').trim()) return false;
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
  if (userA.length !== userB.length || userA.some((id, i) => id !== userB[i])) return false;
  const colA = [...(a.collapsedColumnIds ?? [])].sort();
  const colB = [...(b.collapsedColumnIds ?? [])].sort();
  return colA.length === colB.length && colA.every((id, i) => id === colB[i]);
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
    throw new Error('View name is required');
  }
  if (isEmptySnapshot(snapshot)) {
    throw new Error('Change a filter or column before saving');
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
            labelSearch: snapshot.labelSearch ?? '',
            userSearch: snapshot.userSearch ?? '',
            epicIds: [...snapshot.epicIds],
            labels: [...snapshot.labels],
            userIds: [...snapshot.userIds],
            collapsedColumnIds: [...(snapshot.collapsedColumnIds ?? [])],
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
        labelSearch: snapshot.labelSearch ?? '',
        userSearch: snapshot.userSearch ?? '',
        epicIds: [...snapshot.epicIds],
        labels: [...snapshot.labels],
        userIds: [...snapshot.userIds],
        collapsedColumnIds: [...(snapshot.collapsedColumnIds ?? [])],
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
