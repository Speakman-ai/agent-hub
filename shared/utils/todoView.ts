/**
 * Search / filter / sort for the personal Todos pane, shared by web and mobile.
 * Pure: callers pass the already-split open list and render the result.
 */

export type TodoViewPriority = 'urgent' | 'high' | 'medium' | 'low';

export type TodoSortKey = 'priority' | 'doDate' | 'title' | 'created';

/** 'any' = no filter, 'none' = no date set, the rest are relative to today. */
export type TodoDateFilter = 'any' | 'overdue' | 'today' | 'week' | 'none';

export interface TodoViewOptions {
  query: string;
  priority: TodoViewPriority | 'all';
  date: TodoDateFilter;
  sort: TodoSortKey;
}

export interface TodoViewItem {
  title: string;
  notes?: string | null;
  priority?: TodoViewPriority | null;
  doDate?: string | null;
  dueAt?: string | null;
  position: number;
  createdAt?: string | null;
}

export const DEFAULT_TODO_VIEW: TodoViewOptions = {
  query: '',
  priority: 'all',
  date: 'any',
  sort: 'priority',
};

export const TODO_SORT_OPTIONS: { value: TodoSortKey; label: string }[] = [
  { value: 'priority', label: 'Urgency' },
  { value: 'doDate', label: 'Do date' },
  { value: 'title', label: 'Subject (A-Z)' },
  { value: 'created', label: 'Newest' },
];

export const TODO_DATE_FILTER_OPTIONS: { value: TodoDateFilter; label: string }[] = [
  { value: 'any', label: 'Any date' },
  { value: 'overdue', label: 'Overdue' },
  { value: 'today', label: 'Due today' },
  { value: 'week', label: 'Next 7 days' },
  { value: 'none', label: 'No date' },
];

export const TODO_PRIORITY_FILTER_OPTIONS: { value: TodoViewPriority | 'all'; label: string }[] = [
  { value: 'all', label: 'All urgencies' },
  { value: 'urgent', label: 'Urgent' },
  { value: 'high', label: 'High' },
  { value: 'medium', label: 'Medium' },
  { value: 'low', label: 'Low' },
];

const PRIORITY_RANK: Record<TodoViewPriority, number> = { urgent: 0, high: 1, medium: 2, low: 3 };

function rank(p: TodoViewPriority | null | undefined): number {
  return PRIORITY_RANK[p ?? 'medium'] ?? PRIORITY_RANK.medium;
}

function dateMs(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  return Number.isNaN(t) ? null : t;
}

function startOfDay(ms: number): number {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

function addLocalDays(ms: number, days: number): number {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + days).getTime();
}

function todoDate(t: TodoViewItem): number | null {
  return dateMs(t.doDate ?? t.dueAt ?? null);
}

/** True when the view differs from the default, i.e. manual reorder no longer applies. */
export function isTodoViewActive(view: TodoViewOptions): boolean {
  return (
    view.query.trim() !== '' ||
    view.priority !== DEFAULT_TODO_VIEW.priority ||
    view.date !== DEFAULT_TODO_VIEW.date ||
    view.sort !== DEFAULT_TODO_VIEW.sort
  );
}

/** Case-insensitive match on title and notes; every whitespace-separated term must hit. */
export function todoMatchesQuery(t: TodoViewItem, query: string): boolean {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return true;
  const haystack = `${t.title}\n${t.notes ?? ''}`.toLowerCase();
  return terms.every((term) => haystack.includes(term));
}

export function todoMatchesDate(t: TodoViewItem, filter: TodoDateFilter, now: Date): boolean {
  if (filter === 'any') return true;
  const ms = todoDate(t);
  if (filter === 'none') return ms === null;
  if (ms === null) return false;
  const day = startOfDay(ms);
  const today = startOfDay(now.getTime());
  if (filter === 'overdue') return day < today;
  if (filter === 'today') return day === today;
  // 'week': today through six days out. Overdue is excluded; it has its own filter.
  // The boundary advances the calendar date, not 7 x 24h, so a DST shift can't
  // pull an eighth day in.
  return day >= today && day < addLocalDays(today, 7);
}

function compare(a: TodoViewItem, b: TodoViewItem, sort: TodoSortKey): number {
  switch (sort) {
    case 'doDate': {
      // Dated todos first, earliest first; undated sink to the bottom.
      const da = todoDate(a);
      const db = todoDate(b);
      if (da !== db) {
        if (da === null) return 1;
        if (db === null) return -1;
        return da - db;
      }
      return rank(a.priority) - rank(b.priority) || a.position - b.position;
    }
    case 'title':
      return (
        a.title.localeCompare(b.title, undefined, { sensitivity: 'base' }) ||
        a.position - b.position
      );
    case 'created': {
      const ca = dateMs(a.createdAt) ?? 0;
      const cb = dateMs(b.createdAt) ?? 0;
      return cb - ca || a.position - b.position;
    }
    case 'priority':
    default:
      return rank(a.priority) - rank(b.priority) || a.position - b.position;
  }
}

/** Filter then sort. Returns a new array; the input is not mutated. */
export function applyTodoView<T extends TodoViewItem>(
  todos: T[],
  view: TodoViewOptions,
  now: Date = new Date(),
): T[] {
  return todos
    .filter(
      (t) =>
        todoMatchesQuery(t, view.query) &&
        (view.priority === 'all' || (t.priority ?? 'medium') === view.priority) &&
        todoMatchesDate(t, view.date, now),
    )
    .sort((a, b) => compare(a, b, view.sort));
}
