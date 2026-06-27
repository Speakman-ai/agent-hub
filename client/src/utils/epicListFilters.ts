import { ticketsForEpic } from './epicScopeStats';
import { cardMatchesLabelFilter, collectDistinctLabels, parseCardLabels } from './kanbanLabels';
import { epicMatchesUserFilter } from './kanbanUserFilter';

type EpicRow = {
  id: string;
  name: string;
  goal?: string | null;
  description?: string | null;
  labels?: string | null;
  assigned_user_id?: string | null;
};

export type EpicListFilterScope = 'all' | 'with-tickets' | 'empty';

export type EpicListFilters = {
  search: string;
  scope: EpicListFilterScope;
  selectedLabels: Set<string>;
  selectedUserIds: Set<string>;
};

export function createDefaultEpicListFilters(): EpicListFilters {
  return {
    search: '',
    scope: 'all',
    selectedLabels: new Set(),
    selectedUserIds: new Set(),
  };
}

export function epicTicketCount(epicId: string, cards: any[]): number {
  return ticketsForEpic(cards, epicId).length;
}

export function collectDistinctEpicLabels(epics: Array<{ labels?: string | null }>): string[] {
  return collectDistinctLabels(epics);
}

export function sortEpicsWithEmptyLast(epics: EpicRow[], cards: any[]): EpicRow[] {
  return [...epics].sort((a, b) => {
    const aEmpty = epicTicketCount(a.id, cards) === 0;
    const bEmpty = epicTicketCount(b.id, cards) === 0;
    if (aEmpty !== bEmpty) return aEmpty ? 1 : -1;
    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
  });
}

export function filterEpicsForList(
  epics: EpicRow[],
  filters: EpicListFilters,
  cards: any[],
): EpicRow[] {
  const q = filters.search.trim().toLowerCase();
  return epics.filter((epic) => {
    const count = epicTicketCount(epic.id, cards);
    if (filters.scope === 'with-tickets' && count === 0) return false;
    if (filters.scope === 'empty' && count > 0) return false;
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
): EpicRow[] {
  return sortEpicsWithEmptyLast(filterEpicsForList(epics, filters, cards), cards);
}
