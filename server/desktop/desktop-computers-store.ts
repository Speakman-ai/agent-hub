/**
 * Persistent identity of desktop computers: which VM id and network slot a
 * (user, agent, project) computer owns, and when it was last used. The row
 * outlives sessions and Hub restarts; it is removed only when the computer's
 * storage is deleted.
 */
import type Database from 'better-sqlite3';
import { getOrgsDb } from '../orgs.js';
import type { DesktopComputerKey, DesktopRuntimeKind } from './desktop-runtime.js';

export interface DesktopComputerRecord extends DesktopComputerKey {
  kind: DesktopRuntimeKind;
  vmId: string;
  slot: number | null;
  lastActiveAt: number | null;
}

export interface DesktopComputersStore {
  get(key: DesktopComputerKey, kind: DesktopRuntimeKind): DesktopComputerRecord | null;
  /** Insert a new computer. Throws on a duplicate key or a slot already held. */
  create(record: DesktopComputerRecord): DesktopComputerRecord;
  touch(key: DesktopComputerKey, kind: DesktopRuntimeKind, atMs: number): void;
  delete(key: DesktopComputerKey, kind: DesktopRuntimeKind): boolean;
  /** Every computer this key owns, across backends. */
  listForKey(key: DesktopComputerKey): DesktopComputerRecord[];
  /** Every slot held by a computer of this kind, stopped or running. */
  listSlots(kind: DesktopRuntimeKind): number[];
}

interface Row {
  user_id: string;
  agent_id: string;
  project_id: string;
  kind: DesktopRuntimeKind;
  vm_id: string;
  slot: number | null;
  last_active_at: number | null;
}

function fromRow(row: Row): DesktopComputerRecord {
  return {
    userId: row.user_id,
    agentId: row.agent_id,
    projectId: row.project_id,
    kind: row.kind,
    vmId: row.vm_id,
    slot: row.slot,
    lastActiveAt: row.last_active_at,
  };
}

const KEY_WHERE = 'user_id = ? AND agent_id = ? AND project_id = ? AND kind = ?';

function keyArgs(key: DesktopComputerKey, kind: DesktopRuntimeKind): string[] {
  return [key.userId, key.agentId, key.projectId, kind];
}

export function createDesktopComputersStore(
  db: () => Database.Database = getOrgsDb,
): DesktopComputersStore {
  return {
    get(key, kind) {
      const row = db()
        .prepare(`SELECT * FROM desktop_computers WHERE ${KEY_WHERE}`)
        .get(...keyArgs(key, kind)) as Row | undefined;
      return row ? fromRow(row) : null;
    },
    create(record) {
      db()
        .prepare(
          `INSERT INTO desktop_computers
             (user_id, agent_id, project_id, kind, vm_id, slot, last_active_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          record.userId,
          record.agentId,
          record.projectId,
          record.kind,
          record.vmId,
          record.slot,
          record.lastActiveAt,
        );
      return { ...record };
    },
    touch(key, kind, atMs) {
      db()
        .prepare(`UPDATE desktop_computers SET last_active_at = ? WHERE ${KEY_WHERE}`)
        .run(atMs, ...keyArgs(key, kind));
    },
    delete(key, kind) {
      return (
        db()
          .prepare(`DELETE FROM desktop_computers WHERE ${KEY_WHERE}`)
          .run(...keyArgs(key, kind)).changes > 0
      );
    },
    listForKey(key) {
      const rows = db()
        .prepare(
          `SELECT * FROM desktop_computers
           WHERE user_id = ? AND agent_id = ? AND project_id = ? ORDER BY kind`,
        )
        .all(key.userId, key.agentId, key.projectId) as Row[];
      return rows.map(fromRow);
    },
    listSlots(kind) {
      const rows = db()
        .prepare(
          `SELECT slot FROM desktop_computers WHERE kind = ? AND slot IS NOT NULL ORDER BY slot`,
        )
        .all(kind) as { slot: number }[];
      return rows.map((r) => r.slot);
    },
  };
}
