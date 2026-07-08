/**
 * linkedTodos.ts — the pure logic behind the reverse (bidirectional) display of
 * a card / epic's linked-from todos (spec TODO-TO-TICKET, "target shows
 * from-todo" half). Shared 1:1 between the web and mobile `LinkedTodosPanel` so
 * both clients build the same fetch target and shape the same display list.
 * Kept free of React / network so it is unit-testable in isolation.
 *
 * The panel reads `GET /api/me/todos/linked?targetType&targetId&projectId`,
 * which returns only the CALLER's own todos pointing at that target (the server
 * scopes per-user). A card or epic target is project-scoped and always carries
 * a `projectId`; sessions are handled elsewhere and are not a panel target.
 */

/** Panel target type — only card / epic get a reverse panel (a session link is a lightweight association, not bidirectional). */
export type LinkedTodoTargetType = 'card' | 'epic';

/** The exact query `GET /api/me/todos/linked` needs for a card / epic. */
export interface LinkedTodoTarget {
  targetType: LinkedTodoTargetType;
  targetId: string;
  projectId: string;
}

/** Minimal shape of a card / epic entity the panel is rendered against. */
export interface LinkedTodoEntity {
  id?: string | null;
  /** Draft (unsaved) cards carry this flag and have no persisted id yet. */
  __draft?: boolean;
}

/** The wire fields the panel reads off each linked todo (subset of UserTodoWire). */
export interface LinkedTodoInput {
  id: string;
  title: string;
  status: 'open' | 'done';
  priority?: string | null;
  doDate?: string | null;
  dueAt?: string | null;
}

/** Priority normalized to the kanban-card enum, defaulting to `medium`. */
export type LinkedTodoPriority = 'urgent' | 'high' | 'medium' | 'low';

/** Display shape the panel renders per linked todo. */
export interface LinkedTodoSummary {
  id: string;
  title: string;
  done: boolean;
  priority: LinkedTodoPriority;
  /** The scheduling "do" date, falling back to the deprecated `dueAt`. */
  doDate: string | null;
}

const VALID_PRIORITIES: readonly LinkedTodoPriority[] = ['urgent', 'high', 'medium', 'low'];

/**
 * Build the fetch target for a card / epic, or `null` when the panel must not
 * fetch — an unsaved draft, a missing entity id, or a missing project id (a
 * card / epic link is always project-scoped). Returning `null` lets the caller
 * skip the request and render nothing.
 */
export function buildLinkedTodoTarget(
  targetType: LinkedTodoTargetType,
  entity: LinkedTodoEntity | null | undefined,
  projectId: string | null | undefined,
): LinkedTodoTarget | null {
  if (!entity || entity.__draft) return null;
  const targetId = entity.id?.trim();
  const project = projectId?.trim();
  if (!targetId || !project) return null;
  return { targetType, targetId, projectId: project };
}

/** Normalize an unknown priority string to the enum, defaulting to `medium`. */
export function normalizeTodoPriority(priority: string | null | undefined): LinkedTodoPriority {
  const p = String(priority ?? '').toLowerCase() as LinkedTodoPriority;
  return VALID_PRIORITIES.includes(p) ? p : 'medium';
}

/** Shape one linked todo for display (priority normalized, do-date resolved). */
export function summarizeLinkedTodo(todo: LinkedTodoInput): LinkedTodoSummary {
  return {
    id: todo.id,
    title: todo.title,
    done: todo.status === 'done',
    priority: normalizeTodoPriority(todo.priority),
    doDate: todo.doDate ?? todo.dueAt ?? null,
  };
}

/**
 * Shape a list of linked todos for display: open todos first (preserving the
 * server's position order), completed ones after. The server already orders by
 * position; this only floats done rows to the bottom so the actionable ones
 * lead.
 */
export function summarizeLinkedTodos(todos: LinkedTodoInput[]): LinkedTodoSummary[] {
  const summaries = todos.map(summarizeLinkedTodo);
  const open = summaries.filter((t) => !t.done);
  const done = summaries.filter((t) => t.done);
  return [...open, ...done];
}
