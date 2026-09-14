/**
 * org-todos-store.ts — Shared, organization-wide todos, keyed by org_id.
 *
 * The team-visible counterpart to `user-todos-store.ts`. Every member of an
 * org sees and mutates the same list (there is NO per-user ownership check —
 * the list is deliberately shared). Rows live in the shared orgs.db (schema in
 * `org-todos-schema.ts`), independent of any project board. This is a distinct
 * list, not an aggregation of members' personal todos.
 *
 * Ordering:
 *   `position` is scoped per-org. `createOrgTodo` appends at the end
 *   (`COALESCE(MAX(position), -1) + 1` for the org); `listOrgTodos` returns
 *   rows `ORDER BY position ASC`. `reorderOrgTodos` reassigns dense positions
 *   from an explicit id order (ids not in the org are ignored).
 */
import { v4 as uuidv4 } from 'uuid';
import { getOrgsDb } from './orgs.js';

export type OrgTodoStatus = 'open' | 'done';

/** Todo priority — reuses the kanban-card / personal-todo priority enum. */
export const ORG_TODO_PRIORITIES = ['urgent', 'high', 'medium', 'low'] as const;
export type OrgTodoPriority = (typeof ORG_TODO_PRIORITIES)[number];

/** Public-facing org-todo shape. */
export interface OrgTodo {
  id: string;
  orgId: string;
  title: string;
  notes: string;
  status: OrgTodoStatus;
  priority: OrgTodoPriority;
  /** Day the team plans to WORK the task (scheduling "do" date, not a deadline). */
  doDate: string | null;
  doStartAt: string | null;
  doEndAt: string | null;
  position: number;
  /** Member who added the todo, or null for apiKey / local-bundled creates. */
  createdByUserId: string | null;
  createdAt: string;
  updatedAt: string;
}

interface OrgTodoRow {
  id: string;
  org_id: string;
  title: string;
  notes: string;
  status: OrgTodoStatus;
  priority: OrgTodoPriority;
  do_date: string | null;
  do_start_at: string | null;
  do_end_at: string | null;
  position: number;
  created_by_user_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface CreateOrgTodoInput {
  orgId: string;
  title: string;
  notes?: string;
  priority?: OrgTodoPriority;
  doDate?: string | null;
  doStartAt?: string | null;
  doEndAt?: string | null;
  createdByUserId?: string | null;
}

export interface UpdateOrgTodoInput {
  title?: string;
  notes?: string;
  status?: OrgTodoStatus;
  priority?: OrgTodoPriority;
  doDate?: string | null;
  doStartAt?: string | null;
  doEndAt?: string | null;
}

function rowToTodo(row: OrgTodoRow): OrgTodo {
  return {
    id: row.id,
    orgId: row.org_id,
    title: row.title,
    notes: row.notes,
    status: row.status,
    priority: row.priority,
    doDate: row.do_date,
    doStartAt: row.do_start_at,
    doEndAt: row.do_end_at,
    position: row.position,
    createdByUserId: row.created_by_user_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Create a todo in `orgId`'s shared list. Appends at the end of the org's list
 * (next position). `title` is required and trimmed; an empty title throws.
 */
export function createOrgTodo(input: CreateOrgTodoInput): OrgTodo {
  const title = input.title.trim();
  if (title.length === 0) {
    throw new Error('title is required');
  }

  const db = getOrgsDb();
  const id = uuidv4();
  const now = new Date().toISOString();
  const nextPosition = (
    db
      .prepare(`SELECT COALESCE(MAX(position), -1) + 1 AS p FROM org_todos WHERE org_id = ?`)
      .get(input.orgId) as { p: number }
  ).p;

  db.prepare(
    `INSERT INTO org_todos
       (id, org_id, title, notes, status, priority,
        do_date, do_start_at, do_end_at, position,
        created_by_user_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.orgId,
    title,
    input.notes ?? '',
    input.priority ?? 'medium',
    input.doDate ?? null,
    input.doStartAt ?? null,
    input.doEndAt ?? null,
    nextPosition,
    input.createdByUserId ?? null,
    now,
    now,
  );

  return getOrgTodo(input.orgId, id)!;
}

/** A single todo in `orgId`'s list, or null if it doesn't exist / isn't that org's. */
export function getOrgTodo(orgId: string, id: string): OrgTodo | null {
  const db = getOrgsDb();
  const row = db.prepare(`SELECT * FROM org_todos WHERE id = ? AND org_id = ?`).get(id, orgId) as
    | OrgTodoRow
    | undefined;
  return row ? rowToTodo(row) : null;
}

/**
 * All todos for an org in per-org order. Pass `status` to filter to only open
 * or only done todos; omit for every todo.
 */
export function listOrgTodos(orgId: string, opts: { status?: OrgTodoStatus } = {}): OrgTodo[] {
  const db = getOrgsDb();
  const rows = opts.status
    ? (db
        .prepare(
          `SELECT * FROM org_todos WHERE org_id = ? AND status = ?
           ORDER BY position ASC, created_at ASC`,
        )
        .all(orgId, opts.status) as OrgTodoRow[])
    : (db
        .prepare(
          `SELECT * FROM org_todos WHERE org_id = ?
           ORDER BY position ASC, created_at ASC`,
        )
        .all(orgId) as OrgTodoRow[]);
  return rows.map(rowToTodo);
}

/**
 * Patch a todo's mutable fields. Only keys present in `patch` are written;
 * `undefined` values are ignored (so callers can send a sparse update).
 * Returns the updated todo, or null if it doesn't exist / isn't the org's.
 */
export function updateOrgTodo(
  orgId: string,
  id: string,
  patch: UpdateOrgTodoInput,
): OrgTodo | null {
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

  if (sets.length === 0) return getOrgTodo(orgId, id);

  sets.push(`updated_at = ?`);
  values.push(new Date().toISOString());

  const db = getOrgsDb();
  const result = db
    .prepare(`UPDATE org_todos SET ${sets.join(', ')} WHERE id = ? AND org_id = ?`)
    .run(...values, id, orgId);
  if (result.changes === 0) return null;
  return getOrgTodo(orgId, id);
}

/** Hard-delete a todo. Returns true if a row was removed. */
export function deleteOrgTodo(orgId: string, id: string): boolean {
  const db = getOrgsDb();
  const result = db.prepare(`DELETE FROM org_todos WHERE id = ? AND org_id = ?`).run(id, orgId);
  return result.changes > 0;
}

/**
 * Reassign per-org positions from an explicit id order. Ids not in the org (or
 * that don't exist) are skipped. Any of the org's todos NOT named in
 * `orderedIds` keep their relative order and are appended after the listed
 * ones. Runs in a single transaction so a partial reorder can't persist.
 */
export function reorderOrgTodos(orgId: string, orderedIds: string[]): OrgTodo[] {
  const db = getOrgsDb();
  const owned = new Set(
    (
      db.prepare(`SELECT id FROM org_todos WHERE org_id = ?`).all(orgId) as {
        id: string;
      }[]
    ).map((r) => r.id),
  );
  const requested = orderedIds.filter((id) => owned.has(id));
  const requestedSet = new Set(requested);
  // Todos not mentioned in the request keep their existing order, appended after.
  const remainder = (
    db
      .prepare(`SELECT id FROM org_todos WHERE org_id = ? ORDER BY position ASC, created_at ASC`)
      .all(orgId) as { id: string }[]
  )
    .map((r) => r.id)
    .filter((id) => !requestedSet.has(id));
  const finalOrder = [...requested, ...remainder];

  const now = new Date().toISOString();
  const setPos = db.prepare(
    `UPDATE org_todos SET position = ?, updated_at = ? WHERE id = ? AND org_id = ?`,
  );
  const tx = db.transaction((ids: string[]) => {
    ids.forEach((id, index) => setPos.run(index, now, id, orgId));
  });
  tx(finalOrder);

  return listOrgTodos(orgId);
}
