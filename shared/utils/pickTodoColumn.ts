/**
 * Resolve the kanban column a captured item should land in when converting a
 * note line into a ticket: the column literally named "To Do" (case- and
 * whitespace-insensitive), falling back to the first column, or `null` when the
 * board has no columns. Shared by the web and mobile Notes → ticket flows so the
 * fallback behaviour is defined in exactly one, unit-tested place.
 */

export interface BoardColumnLike {
  id: string;
  name?: string | null;
}

export function pickTodoColumn<T extends BoardColumnLike>(
  columns: T[] | null | undefined,
): T | null {
  if (!Array.isArray(columns) || columns.length === 0) return null;
  const todo = columns.find((c) => (c.name || '').toLowerCase().trim() === 'to do');
  return todo || columns[0] || null;
}
