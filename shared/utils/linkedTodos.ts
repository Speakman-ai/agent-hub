/**
 * Reverse linked-from todos for a card/epic (`GET /api/me/todos/linked`).
 * Server scopes to the caller's own todos.
 */

/** Card/epic only; session links are not bidirectional. */
export type LinkedTodoTargetType = 'card' | 'epic';

/** Query for `GET /api/me/todos/linked`. */
export interface LinkedTodoTarget {
  targetType: LinkedTodoTargetType;
  targetId: string;
  projectId: string;
}

/** Minimal shape of a card / epic entity the panel is rendered against. */
export interface LinkedTodoEntity {
  id?: string | null;
  /** Draft cards have `__draft` and no persisted id yet. */
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
  /** Scheduling "do" date, falling back to `dueAt`. */
  doDate: string | null;
}

const VALID_PRIORITIES: readonly LinkedTodoPriority[] = ['urgent', 'high', 'medium', 'low'];

/** Null for drafts or missing ids (skip the fetch). */
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

/** Open first (server order), done after. */
export function summarizeLinkedTodos(todos: LinkedTodoInput[]): LinkedTodoSummary[] {
  const summaries = todos.map(summarizeLinkedTodo);
  const open = summaries.filter((t) => !t.done);
  const done = summaries.filter((t) => t.done);
  return [...open, ...done];
}
