/**
 * Reclaim host ports held by `failed` preview process rows.
 *
 * `worktree_preview_processes.port` is globally UNIQUE. The allocators in
 * both runtimes only treat `pending`/`starting`/`ready` as "taken", so
 * a leftover `failed` row makes `allocatePort()` return that port while
 * the INSERT still hits SQLITE_CONSTRAINT_UNIQUE — the error users see
 * after a failed boot or server rebuild with a stale DB.
 */
import type { Database } from 'better-sqlite3';

export type ReclaimFailedPortResult = {
  groupId: string;
  groupDeleted: boolean;
};

export function reclaimFailedPortHolder(
  db: Database,
  port: number,
): ReclaimFailedPortResult | null {
  const conflicting = db
    .prepare(
      `SELECT id, status, group_id
         FROM worktree_preview_processes
        WHERE port = ?`,
    )
    .get(port) as { id: string; status: string; group_id: string } | undefined;

  if (!conflicting || conflicting.status !== 'failed') {
    return null;
  }

  db.prepare(`DELETE FROM worktree_preview_processes WHERE id = ?`).run(conflicting.id);
  const remaining = db
    .prepare(`SELECT COUNT(*) AS n FROM worktree_preview_processes WHERE group_id = ?`)
    .get(conflicting.group_id) as { n: number };
  const groupDeleted = remaining.n === 0;
  if (groupDeleted) {
    db.prepare(`DELETE FROM worktree_preview_groups WHERE id = ?`).run(conflicting.group_id);
    db.prepare(`DELETE FROM worktree_previews WHERE id = ?`).run(conflicting.group_id);
  }
  return { groupId: conflicting.group_id, groupDeleted };
}

/** Delete every `failed` process row (and empty groups) in a port range. */
export function reclaimFailedPortsInRange(db: Database, min: number, max: number): number {
  const ports = db
    .prepare(
      `SELECT DISTINCT port
         FROM worktree_preview_processes
        WHERE port BETWEEN ? AND ?
          AND status = 'failed'`,
    )
    .all(min, max) as Array<{ port: number }>;

  let reclaimed = 0;
  for (const { port } of ports) {
    if (reclaimFailedPortHolder(db, port)) reclaimed++;
  }
  return reclaimed;
}
