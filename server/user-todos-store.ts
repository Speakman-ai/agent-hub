/**
 * user-todos-store.ts — Cross-project personal todos, keyed by user_id.
 *
 * A todo is a per-user, global capture primitive that lives in the shared
 * orgs.db (schema in `user-todos-schema.ts`), independent of any project board
 * or column (spec TODO-MODEL). The REST surface (`/api/me/todos`), the
 * `user_todo_update` WebSocket event, and the promote-to-ticket path build on
 * this store — all writes go through the functions here so ordering and
 * provenance stay consistent.
 *
 * Ordering:
 *   `position` is scoped per-user. `createTodo` appends at the end
 *   (`COALESCE(MAX(position), -1) + 1` for the owner); `listTodos` returns rows
 *   `ORDER BY position ASC`. `reorderTodos` reassigns dense positions from an
 *   explicit id order (ids not owned by the user are ignored).
 */
import { v4 as uuidv4 } from 'uuid';
import { getOrgsDb } from './orgs.js';
import { parseSourceMeta, type TodoSourceType } from './source-provenance.js';

export type TodoStatus = 'open' | 'done';
export type { TodoSourceType };

/**
 * Todo priority — reuses the kanban-card priority enum so a promote maps 1:1
 * (spec TODO-MODEL). Keep in sync with `KanbanCardRow.priority` in types.ts.
 */
export const TODO_PRIORITIES = ['urgent', 'high', 'medium', 'low'] as const;
export type TodoPriority = (typeof TODO_PRIORITIES)[number];

/** Polymorphic link target for a todo (spec TODO-TO-TICKET). */
export const TODO_LINK_TYPES = ['card', 'epic', 'session'] as const;
export type TodoLinkType = (typeof TODO_LINK_TYPES)[number];

/** Public-facing todo shape. `sourceMeta` is parsed from the stored JSON blob. */
export interface UserTodo {
  id: string;
  userId: string;
  title: string;
  notes: string;
  status: TodoStatus;
  priority: TodoPriority;
  /** Day the user plans to WORK the task (scheduling "do" date, not a deadline). */
  doDate: string | null;
  doStartAt: string | null;
  doEndAt: string | null;
  /** Retained for back-compat only; no longer written. Use `doDate`. */
  dueAt: string | null;
  position: number;
  sourceType: TodoSourceType;
  sourceId: string | null;
  sourceMeta: Record<string, unknown> | null;
  /** Polymorphic link (card | epic | session), or null when unlinked. */
  linkedType: TodoLinkType | null;
  linkedId: string | null;
  linkedProjectId: string | null;
  /** Deprecated: superseded by linkedType/linkedId. Kept in sync for a card link. */
  linkedCardId: string | null;
  createdAt: string;
  updatedAt: string;
}

interface UserTodoRow {
  id: string;
  user_id: string;
  title: string;
  notes: string;
  status: TodoStatus;
  priority: TodoPriority;
  do_date: string | null;
  do_start_at: string | null;
  do_end_at: string | null;
  due_at: string | null;
  position: number;
  source_type: TodoSourceType;
  source_id: string | null;
  source_meta: string | null;
  linked_type: TodoLinkType | null;
  linked_id: string | null;
  linked_card_id: string | null;
  linked_project_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface CreateTodoInput {
  userId: string;
  title: string;
  notes?: string;
  priority?: TodoPriority;
  doDate?: string | null;
  doStartAt?: string | null;
  doEndAt?: string | null;
  /** Deprecated: retained for back-compat. Prefer `doDate`. */
  dueAt?: string | null;
  sourceType?: TodoSourceType;
  sourceId?: string | null;
  sourceMeta?: Record<string, unknown> | null;
}

export interface UpdateTodoInput {
  title?: string;
  notes?: string;
  status?: TodoStatus;
  priority?: TodoPriority;
  doDate?: string | null;
  doStartAt?: string | null;
  doEndAt?: string | null;
  /** Deprecated: retained for back-compat. Prefer `doDate`. */
  dueAt?: string | null;
}

function rowToTodo(row: UserTodoRow): UserTodo {
  return {
    id: row.id,
    userId: row.user_id,
    title: row.title,
    notes: row.notes,
    status: row.status,
    priority: row.priority,
    doDate: row.do_date,
    doStartAt: row.do_start_at,
    doEndAt: row.do_end_at,
    dueAt: row.due_at,
    position: row.position,
    sourceType: row.source_type,
    sourceId: row.source_id,
    sourceMeta: parseSourceMeta(row.source_meta),
    linkedType: row.linked_type,
    linkedId: row.linked_id,
    linkedProjectId: row.linked_project_id,
    linkedCardId: row.linked_card_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Create a todo owned by `userId`. Appends at the end of the user's list
 * (next position). `title` is required and trimmed; an empty title throws.
 */
export function createTodo(input: CreateTodoInput): UserTodo {
  const title = input.title.trim();
  if (title.length === 0) {
    throw new Error('title is required');
  }

  const db = getOrgsDb();
  const id = uuidv4();
  const now = new Date().toISOString();
  const nextPosition = (
    db
      .prepare(`SELECT COALESCE(MAX(position), -1) + 1 AS p FROM user_todos WHERE user_id = ?`)
      .get(input.userId) as { p: number }
  ).p;

  db.prepare(
    `INSERT INTO user_todos
       (id, user_id, title, notes, status, priority,
        do_date, do_start_at, do_end_at, due_at, position,
        source_type, source_id, source_meta, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.userId,
    title,
    input.notes ?? '',
    input.priority ?? 'medium',
    input.doDate ?? null,
    input.doStartAt ?? null,
    input.doEndAt ?? null,
    input.dueAt ?? null,
    nextPosition,
    input.sourceType ?? 'manual',
    input.sourceId ?? null,
    input.sourceMeta != null ? JSON.stringify(input.sourceMeta) : null,
    now,
    now,
  );

  return getTodo(input.userId, id)!;
}

/** A single todo owned by `userId`, or null if it doesn't exist / isn't theirs. */
export function getTodo(userId: string, id: string): UserTodo | null {
  const db = getOrgsDb();
  const row = db
    .prepare(`SELECT * FROM user_todos WHERE id = ? AND user_id = ?`)
    .get(id, userId) as UserTodoRow | undefined;
  return row ? rowToTodo(row) : null;
}

/**
 * All todos for a user in per-user order. Pass `status` to filter to only
 * open or only done todos; omit for every todo.
 */
export function listTodos(userId: string, opts: { status?: TodoStatus } = {}): UserTodo[] {
  const db = getOrgsDb();
  const rows = opts.status
    ? (db
        .prepare(
          `SELECT * FROM user_todos WHERE user_id = ? AND status = ?
           ORDER BY position ASC, created_at ASC`,
        )
        .all(userId, opts.status) as UserTodoRow[])
    : (db
        .prepare(
          `SELECT * FROM user_todos WHERE user_id = ?
           ORDER BY position ASC, created_at ASC`,
        )
        .all(userId) as UserTodoRow[]);
  return rows.map(rowToTodo);
}

/**
 * Patch a todo's mutable fields. Only keys present in `patch` are written;
 * `undefined` values are ignored (so callers can send a sparse update).
 * Returns the updated todo, or null if it doesn't exist / isn't the user's.
 */
export function updateTodo(userId: string, id: string, patch: UpdateTodoInput): UserTodo | null {
  const sets: string[] = [];
  const values: unknown[] = [];

  if (patch.title !== undefined) {
    const title = patch.title.trim();
    if (title.length === 0) throw new Error('title cannot be empty');
    sets.push('title = ?');
    values.push(title);
  }
  if (patch.notes !== undefined) {
    sets.push('notes = ?');
    values.push(patch.notes);
  }
  if (patch.status !== undefined) {
    sets.push('status = ?');
    values.push(patch.status);
  }
  if (patch.priority !== undefined) {
    sets.push('priority = ?');
    values.push(patch.priority);
  }
  if (patch.doDate !== undefined) {
    sets.push('do_date = ?');
    values.push(patch.doDate);
  }
  if (patch.doStartAt !== undefined) {
    sets.push('do_start_at = ?');
    values.push(patch.doStartAt);
  }
  if (patch.doEndAt !== undefined) {
    sets.push('do_end_at = ?');
    values.push(patch.doEndAt);
  }
  if (patch.dueAt !== undefined) {
    sets.push('due_at = ?');
    values.push(patch.dueAt);
  }

  if (sets.length === 0) return getTodo(userId, id);

  sets.push(`updated_at = ?`);
  values.push(new Date().toISOString());

  const db = getOrgsDb();
  const result = db
    .prepare(`UPDATE user_todos SET ${sets.join(', ')} WHERE id = ? AND user_id = ?`)
    .run(...values, id, userId);
  if (result.changes === 0) return null;
  return getTodo(userId, id);
}

/** Hard-delete a todo. Returns true if a row was removed. */
export function deleteTodo(userId: string, id: string): boolean {
  const db = getOrgsDb();
  const result = db.prepare(`DELETE FROM user_todos WHERE id = ? AND user_id = ?`).run(id, userId);
  return result.changes > 0;
}

/**
 * Reassign per-user positions from an explicit id order. Ids the user does not
 * own (or that don't exist) are skipped. Any of the user's todos NOT named in
 * `orderedIds` keep their relative order and are appended after the listed
 * ones. Runs in a single transaction so a partial reorder can't persist.
 */
export function reorderTodos(userId: string, orderedIds: string[]): UserTodo[] {
  const db = getOrgsDb();
  const owned = new Set(
    (
      db.prepare(`SELECT id FROM user_todos WHERE user_id = ?`).all(userId) as {
        id: string;
      }[]
    ).map((r) => r.id),
  );
  const requested = orderedIds.filter((id) => owned.has(id));
  const requestedSet = new Set(requested);
  // Todos not mentioned in the request keep their existing order, appended after.
  const remainder = (
    db
      .prepare(`SELECT id FROM user_todos WHERE user_id = ? ORDER BY position ASC, created_at ASC`)
      .all(userId) as { id: string }[]
  )
    .map((r) => r.id)
    .filter((id) => !requestedSet.has(id));
  const finalOrder = [...requested, ...remainder];

  const now = new Date().toISOString();
  const setPos = db.prepare(
    `UPDATE user_todos SET position = ?, updated_at = ? WHERE id = ? AND user_id = ?`,
  );
  const tx = db.transaction((ids: string[]) => {
    ids.forEach((id, index) => setPos.run(index, now, id, userId));
  });
  tx(finalOrder);

  return listTodos(userId);
}

/**
 * Stamp a promoted todo with the kanban card it created (spec TODO-TO-TICKET).
 * Writes the polymorphic link ({card, cardId, projectId}) and keeps the
 * deprecated linked_card_id column in sync for back-compat readers. The todo
 * persists alongside its ticket; the two are joined by this link. Returns the
 * updated todo, or null if it isn't the user's.
 */
export function linkTodoToCard(
  userId: string,
  id: string,
  link: { cardId: string; projectId: string },
): UserTodo | null {
  const db = getOrgsDb();
  const result = db
    .prepare(
      `UPDATE user_todos
          SET linked_type = 'card', linked_id = ?, linked_card_id = ?,
              linked_project_id = ?, updated_at = ?
        WHERE id = ? AND user_id = ?`,
    )
    .run(link.cardId, link.cardId, link.projectId, new Date().toISOString(), id, userId);
  if (result.changes === 0) return null;
  return getTodo(userId, id);
}

export type TodoPromotionClaim =
  | { status: 'claimed'; todo: UserTodo }
  | { status: 'already-linked'; todo: UserTodo }
  | { status: 'not-found' };

/**
 * Atomically claim an unlinked todo for promotion before creating the card.
 * This is the race guard for retry/double-click promotion: only the first
 * caller can stamp the card link; later callers see the existing linked todo
 * and must return that card or reject instead of inserting another card.
 */
export function claimTodoPromotionToCard(
  userId: string,
  id: string,
  link: { cardId: string; projectId: string },
): TodoPromotionClaim {
  const db = getOrgsDb();
  const now = new Date().toISOString();
  const result = db
    .prepare(
      `UPDATE user_todos
          SET linked_type = 'card', linked_id = ?, linked_card_id = ?,
              linked_project_id = ?, updated_at = ?
        WHERE id = ? AND user_id = ?
          AND linked_type IS NULL AND linked_id IS NULL AND linked_card_id IS NULL`,
    )
    .run(link.cardId, link.cardId, link.projectId, now, id, userId);
  const todo = getTodo(userId, id);
  if (!todo) return { status: 'not-found' };
  if (result.changes === 0) return { status: 'already-linked', todo };
  return { status: 'claimed', todo };
}

/**
 * Set the polymorphic link to any supported target (spec TODO-TO-TICKET LINK
 * op). `projectId` scopes a project-bound target (card / epic) and is ignored
 * for a session link. When the target is a card, linked_card_id is kept in
 * sync for back-compat. Returns the updated todo, or null if it isn't the
 * user's.
 */
export function setTodoLink(
  userId: string,
  id: string,
  link: { type: TodoLinkType; id: string; projectId?: string | null },
): UserTodo | null {
  const db = getOrgsDb();
  const projectId = link.type === 'session' ? null : (link.projectId ?? null);
  const linkedCardId = link.type === 'card' ? link.id : null;
  const result = db
    .prepare(
      `UPDATE user_todos
          SET linked_type = ?, linked_id = ?, linked_card_id = ?,
              linked_project_id = ?, updated_at = ?
        WHERE id = ? AND user_id = ?`,
    )
    .run(link.type, link.id, linkedCardId, projectId, new Date().toISOString(), id, userId);
  if (result.changes === 0) return null;
  return getTodo(userId, id);
}

/**
 * Clear a todo's polymorphic link (and the deprecated linked_card_id /
 * linked_project_id columns). Returns the updated todo, or null if it isn't
 * the user's.
 */
export function clearTodoLink(userId: string, id: string): UserTodo | null {
  const db = getOrgsDb();
  const result = db
    .prepare(
      `UPDATE user_todos
          SET linked_type = NULL, linked_id = NULL, linked_card_id = NULL,
              linked_project_id = NULL, updated_at = ?
        WHERE id = ? AND user_id = ?`,
    )
    .run(new Date().toISOString(), id, userId);
  if (result.changes === 0) return null;
  return getTodo(userId, id);
}

/**
 * Reverse lookup for bidirectional display (spec TODO-TO-TICKET): the caller's
 * own todos that link to a given target. Scoped to `userId` because todos are
 * private — a card/epic only ever surfaces the *viewer's* from-todo, never
 * another user's. `projectId` narrows a project-bound target (card / epic); it
 * is ignored (and should be omitted) for a session link. Ordered per-user.
 */
export function listTodosLinkedTo(
  userId: string,
  target: { type: TodoLinkType; id: string; projectId?: string | null },
): UserTodo[] {
  const db = getOrgsDb();
  const scopeProject = target.type !== 'session' && target.projectId != null;
  const sql = scopeProject
    ? `SELECT * FROM user_todos
        WHERE user_id = ? AND linked_type = ? AND linked_id = ? AND linked_project_id = ?
        ORDER BY position ASC, created_at ASC`
    : `SELECT * FROM user_todos
        WHERE user_id = ? AND linked_type = ? AND linked_id = ?
        ORDER BY position ASC, created_at ASC`;
  const rows = scopeProject
    ? (db.prepare(sql).all(userId, target.type, target.id, target.projectId) as UserTodoRow[])
    : (db.prepare(sql).all(userId, target.type, target.id) as UserTodoRow[]);
  return rows.map(rowToTodo);
}
