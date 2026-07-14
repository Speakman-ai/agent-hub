/**
 * Pure helpers for the cross-project personal Todos pane (spec NAV-PLACEMENT).
 *
 * Kept free of React / network so the reorder + due-date logic is unit-testable
 * in isolation. The component (`TodosPage`) owns fetching and rendering; these
 * functions own the ordering business rules and display formatting.
 */

/** Todo priority — mirrors the kanban-card enum so a promote maps 1:1. */
export type TodoPriority = 'urgent' | 'high' | 'medium' | 'low';

/** Polymorphic link target type (spec TODO-TO-TICKET). */
export type TodoLinkType = 'card' | 'epic' | 'session';

export interface TodoLike {
  id: string;
  status: 'open' | 'done';
  /** Day the user plans to work the task. Falls back to the deprecated dueAt. */
  doDate?: string | null;
  dueAt: string | null;
  priority?: TodoPriority | null;
  position: number;
}

/**
 * Return a new id order with the todo at `id` moved one slot in `dir`. If the
 * id is missing, or already at the relevant end, the original order is returned
 * unchanged (so the caller can skip a no-op reorder request).
 */
export function moveTodoId(ids: string[], id: string, dir: 'up' | 'down'): string[] {
  const index = ids.indexOf(id);
  if (index === -1) return ids;
  const target = dir === 'up' ? index - 1 : index + 1;
  if (target < 0 || target >= ids.length) return ids;
  const next = ids.slice();
  [next[index], next[target]] = [next[target], next[index]];
  return next;
}

/**
 * Split a todo list into open and done buckets, preserving each bucket's
 * incoming (position) order. Open todos render first; completed ones drop to a
 * collapsed section below.
 */
export function splitTodos<T extends TodoLike>(todos: T[]): { open: T[]; done: T[] } {
  const open: T[] = [];
  const done: T[] = [];
  for (const t of todos) (t.status === 'done' ? done : open).push(t);
  return { open, done };
}

/**
 * Priority sort rank — lower is more urgent. Reuses the kanban-card ordering so
 * `urgent` floats to the top and an unset/unknown priority sorts as `medium`.
 */
const PRIORITY_RANK: Record<TodoPriority, number> = {
  urgent: 0,
  high: 1,
  medium: 2,
  low: 3,
};

export function priorityRank(priority: TodoPriority | null | undefined): number {
  return PRIORITY_RANK[(priority as TodoPriority) ?? 'medium'] ?? PRIORITY_RANK.medium;
}

/**
 * Compare two todos for the open-list display order: most-urgent first, then by
 * position so a manual reorder still decides ties within a priority band.
 */
export function comparePriority<T extends TodoLike>(a: T, b: T): number {
  const byPriority = priorityRank(a.priority) - priorityRank(b.priority);
  return byPriority !== 0 ? byPriority : a.position - b.position;
}

/** Order open todos urgent→low, breaking ties by position. Pure (no mutation). */
export function sortOpenTodos<T extends TodoLike>(todos: T[]): T[] {
  return todos.slice().sort(comparePriority);
}

/** The scheduling "do" date, falling back to the deprecated dueAt for old rows. */
export function todoDoDate(todo: { doDate?: string | null; dueAt?: string | null }): string | null {
  return todo.doDate ?? todo.dueAt ?? null;
}

/**
 * Human label for an optional do-date time window ('9:00 AM – 10:30 AM',
 * '2:00 PM', or '' when neither bound is set). Rendered next to the do-date.
 */
export function timeWindowLabel(
  startAt: string | null | undefined,
  endAt: string | null | undefined,
): string {
  const start = formatClock(startAt);
  const end = formatClock(endAt);
  if (start && end) return `${start} – ${end}`;
  return start || end || '';
}

function formatClock(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

/**
 * Badge label for a todo's polymorphic link, or '' when unlinked. Prefers the
 * new `linkedType`, falling back to the deprecated `linkedCardId` ('Ticket').
 */
export function todoLinkLabel(todo: {
  linkedType?: TodoLinkType | null;
  linkedCardId?: string | null;
}): string {
  switch (todo.linkedType) {
    case 'card':
      return 'Ticket';
    case 'epic':
      return 'Epic';
    case 'session':
      return 'Session';
    default:
      return todo.linkedCardId ? 'Ticket' : '';
  }
}

/** Local-midnight start of the given date, for whole-day due comparisons. */
function startOfDay(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

export type DueState = 'overdue' | 'today' | 'tomorrow' | 'upcoming' | 'none';

/**
 * Classify a due date relative to `now`. Comparison is by calendar day (local
 * time), so "today" means any time today regardless of the stored clock.
 */
export function dueState(dueAt: string | null | undefined, now: Date = new Date()): DueState {
  if (!dueAt) return 'none';
  const due = new Date(dueAt);
  if (Number.isNaN(due.getTime())) return 'none';
  const dueDay = startOfDay(due);
  const today = startOfDay(now);
  const oneDay = 24 * 60 * 60 * 1000;
  if (dueDay < today) return 'overdue';
  if (dueDay === today) return 'today';
  if (dueDay === today + oneDay) return 'tomorrow';
  return 'upcoming';
}

/** Short human label for a due date ('Today', 'Overdue', 'Jul 12', …). */
export function dueLabel(dueAt: string | null | undefined, now: Date = new Date()): string {
  const state = dueState(dueAt, now);
  if (state === 'none') return '';
  if (state === 'today') return 'Today';
  if (state === 'tomorrow') return 'Tomorrow';
  const due = new Date(dueAt as string);
  const dateLabel = due.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  return state === 'overdue' ? `Overdue · ${dateLabel}` : dateLabel;
}

/**
 * Convert a `<input type="date">` value (YYYY-MM-DD, or '') into the ISO string
 * we store, or null to clear. An empty string clears the due date.
 */
export function dateInputToIso(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const parsed = new Date(`${trimmed}T00:00:00`);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString();
}

/** Convert a stored ISO due date back into a `<input type="date">` value. */
export function isoToDateInput(dueAt: string | null | undefined): string {
  if (!dueAt) return '';
  const d = new Date(dueAt);
  if (Number.isNaN(d.getTime())) return '';
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}
