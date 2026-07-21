import { ticketsForEpic } from './epicScopeStats';
import { DEFAULT_EPIC_LIST_STATE_FILTER } from './epics';
import { cardMatchesLabelFilter, collectDistinctLabels, parseCardLabels } from './kanbanLabels';
import { epicMatchesUserFilter } from './kanbanUserFilter';

type EpicRow = {
  id: string;
  name: string;
  goal?: string | null;
  description?: string | null;
  state?: 'not_started' | 'in_progress' | 'done' | null;
  labels?: string | null;
  assigned_user_id?: string | null;
};

export type EpicListFilterScope = 'all' | 'with-tickets' | 'empty';
export type EpicListFilterState = 'all' | 'not_started' | 'in_progress' | 'done';

export type EpicListFilters = {
  search: string;
  scope: EpicListFilterScope;
  state: EpicListFilterState;
  selectedLabels: Set<string>;
  selectedUserIds: Set<string>;
};

export function createDefaultEpicListFilters(): EpicListFilters {
  return {
    search: '',
    scope: 'all',
    state: DEFAULT_EPIC_LIST_STATE_FILTER,
    selectedLabels: new Set(),
    selectedUserIds: new Set(),
  };
}

export function epicTicketCount(epicId: string, cards: any[], columns?: any[]): number {
  return ticketsForEpic(cards, epicId, columns).length;
}

export function collectDistinctEpicLabels(epics: Array<{ labels?: string | null }>): string[] {
  return collectDistinctLabels(epics);
}

export function sortEpicsWithEmptyLast(epics: EpicRow[], cards: any[], columns?: any[]): EpicRow[] {
  return [...epics].sort((a, b) => {
    const aEmpty = epicTicketCount(a.id, cards, columns) === 0;
    const bEmpty = epicTicketCount(b.id, cards, columns) === 0;
    if (aEmpty !== bEmpty) return aEmpty ? 1 : -1;
    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
  });
}

export function filterEpicsForList(
  epics: EpicRow[],
  filters: EpicListFilters,
  cards: any[],
  columns?: any[],
): EpicRow[] {
  const q = filters.search.trim().toLowerCase();
  return epics.filter((epic) => {
    const count = epicTicketCount(epic.id, cards, columns);
    if (filters.scope === 'with-tickets' && count === 0) return false;
    if (filters.scope === 'empty' && count > 0) return false;
    if (filters.state !== 'all' && epic.state !== filters.state) return false;
    if (!cardMatchesLabelFilter(epic, filters.selectedLabels)) return false;
    if (!epicMatchesUserFilter(epic, filters.selectedUserIds)) return false;
    if (!q) return true;
    const labelHaystack = parseCardLabels(epic.labels).join(' ');
    const haystack = [epic.name, epic.goal ?? '', epic.description ?? '', labelHaystack]
      .join('\n')
      .toLowerCase();
    return haystack.includes(q);
  });
}

export function applyEpicListFilters(
  epics: EpicRow[],
  filters: EpicListFilters,
  cards: any[],
  columns?: any[],
): EpicRow[] {
  return sortEpicsWithEmptyLast(filterEpicsForList(epics, filters, cards, columns), cards, columns);
}
