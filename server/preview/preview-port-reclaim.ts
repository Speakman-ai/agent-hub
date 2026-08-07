/**
 * Reclaim host ports held by `failed` preview process rows.
 *
 * Host-dialed preview ports are unique across the pool. The allocator only
 * treats `pending`/`starting`/`ready` as "taken", so a leftover `failed` row
 * makes `allocatePort()` return that port while the INSERT still hits
 * SQLITE_CONSTRAINT_UNIQUE — the error users see after a failed boot or server
 * rebuild with a stale DB.
 *
 * Everything here is scoped to `dial_scope = 'host'`. An env-scoped row's port
 * is namespaced inside a session container: it holds no host port to reclaim,
 * the same number legitimately recurs across sessions (so a lookup by port
 * alone is ambiguous), and its pid belongs to another session's environment —
 * killing it would tear down an unrelated, healthy preview.
 */
import type { Database } from 'better-sqlite3';

export type ReclaimFailedPortResult = {
  groupId: string;
  groupDeleted: boolean;
};

/**
 * Kill the process recorded on a row whose port is being released.
 * Defaults to a real `process.kill`; tests inject a spy.
 *
 * Reclaiming a port while its process still listens is how an orphan
 * ends up serving a *different* session's preview, so the kill happens
 * before the row (and therefore the port reservation) disappears.
 */
export type KillReclaimedPidFn = (pid: number) => void;

const defaultKillReclaimedPid: KillReclaimedPidFn = (pid) => {
  // The row is failed and about to be deleted — no reason to negotiate a
  // graceful shutdown. Group form first so npm → vite children go too.
  for (const target of [-pid, pid]) {
    try {
      process.kill(target, 'SIGKILL');
      return;
    } catch {
      // ESRCH: already gone, or not a group leader — try the bare pid.
    }
  }
};

export function reclaimFailedPortHolder(
  db: Database,
  port: number,
  killPid: KillReclaimedPidFn = defaultKillReclaimedPid,
): ReclaimFailedPortResult | null {
  const conflicting = db
    .prepare(
      `SELECT id, status, group_id, pid
         FROM worktree_preview_processes
        WHERE port = ? AND dial_scope = 'host'`,
    )
    .get(port) as { id: string; status: string; group_id: string; pid: number | null } | undefined;

  if (!conflicting || conflicting.status !== 'failed') {
    return null;
  }

  if (conflicting.pid) killPid(conflicting.pid);
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
export function reclaimFailedPortsInRange(
  db: Database,
  min: number,
  max: number,
  killPid: KillReclaimedPidFn = defaultKillReclaimedPid,
): number {
  const ports = db
    .prepare(
      `SELECT DISTINCT port
         FROM worktree_preview_processes
        WHERE port BETWEEN ? AND ?
          AND status = 'failed'
          AND dial_scope = 'host'`,
    )
    .all(min, max) as Array<{ port: number }>;

  let reclaimed = 0;
  for (const { port } of ports) {
    if (reclaimFailedPortHolder(db, port, killPid)) reclaimed++;
  }
  return reclaimed;
}
