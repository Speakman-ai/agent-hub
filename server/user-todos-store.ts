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

export type TodoStatus = 'open' | 'done';
export type TodoSourceType = 'manual' | 'email' | 'calendar';

/** Public-facing todo shape. `sourceMeta` is parsed from the stored JSON blob. */
export interface UserTodo {
  id: string;
  userId: string;
  title: string;
  notes: string;
  status: TodoStatus;
  dueAt: string | null;
  position: number;
  sourceType: TodoSourceType;
  sourceId: string | null;
  sourceMeta: Record<string, unknown> | null;
  linkedCardId: string | null;
  linkedProjectId: string | null;
  createdAt: string;
  updatedAt: string;
}

interface UserTodoRow {
  id: string;
  user_id: string;
  title: string;
  notes: string;
  status: TodoStatus;
  due_at: string | null;
  position: number;
  source_type: TodoSourceType;
  source_id: string | null;
  source_meta: string | null;
  linked_card_id: string | null;
  linked_project_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface CreateTodoInput {
  userId: string;
  title: string;
  notes?: string;
  dueAt?: string | null;
  sourceType?: TodoSourceType;
  sourceId?: string | null;
  sourceMeta?: Record<string, unknown> | null;
}

export interface UpdateTodoInput {
  title?: string;
  notes?: string;
  status?: TodoStatus;
  dueAt?: string | null;
}

function parseSourceMeta(json: string | null): Record<string, unknown> | null {
  if (json == null) return null;
  try {
    const parsed = JSON.parse(json);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function rowToTodo(row: UserTodoRow): UserTodo {
  return {
    id: row.id,
    userId: row.user_id,
    title: row.title,
    notes: row.notes,
    status: row.status,
    dueAt: row.due_at,
    position: row.position,
    sourceType: row.source_type,
    sourceId: row.source_id,
    sourceMeta: parseSourceMeta(row.source_meta),
    linkedCardId: row.linked_card_id,
    linkedProjectId: row.linked_project_id,
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
       (id, user_id, title, notes, status, due_at, position,
        source_type, source_id, source_meta, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.userId,
    title,
    input.notes ?? '',
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
 * The todo persists alongside its ticket; the two are joined by this link.
 * Returns the updated todo, or null if it isn't the user's.
 */
export function linkTodoToCard(
  userId: string,
  id: string,
  link: { cardId: string; projectId: string },
): UserTodo | null {
  const db = getOrgsDb();
  const result = db
    .prepare(
      `UPDATE user_todos SET linked_card_id = ?, linked_project_id = ?, updated_at = ?
       WHERE id = ? AND user_id = ?`,
    )
    .run(link.cardId, link.projectId, new Date().toISOString(), id, userId);
  if (result.changes === 0) return null;
  return getTodo(userId, id);
}
