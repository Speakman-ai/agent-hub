import Database from 'better-sqlite3';
import { describe, it, expect, beforeEach } from 'vitest';
import { WORKTREE_PREVIEWS_SCHEMA, WORKTREE_PREVIEW_GROUPS_SCHEMA } from './preview-schema.js';
import { reclaimFailedPortHolder, reclaimFailedPortsInRange } from './preview-port-reclaim.js';

function freshDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(WORKTREE_PREVIEWS_SCHEMA);
  db.exec(WORKTREE_PREVIEW_GROUPS_SCHEMA);
  return db;
}

describe('preview-port-reclaim', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = freshDb();
  });

  it('deletes a failed process row and its empty group', () => {
    db.prepare(
      `INSERT INTO worktree_preview_groups (id, session_id, project_id, status)
       VALUES ('g1', 's1', 'p1', 'failed')`,
    ).run();
    db.prepare(
      `INSERT INTO worktree_preview_processes
         (id, group_id, name, pid, port, url, log_path, status)
       VALUES ('p1', 'g1', 'entry', NULL, 4100, 'http://localhost:4100', NULL, 'failed')`,
    ).run();

    const result = reclaimFailedPortHolder(db, 4100);
    expect(result).toEqual({ groupId: 'g1', groupDeleted: true });
    expect(
      db.prepare(`SELECT COUNT(*) AS n FROM worktree_preview_processes`).get() as { n: number },
    ).toEqual({ n: 0 });
    expect(
      db.prepare(`SELECT COUNT(*) AS n FROM worktree_preview_groups`).get() as { n: number },
    ).toEqual({ n: 0 });
  });

  it('does not reclaim ready or starting rows', () => {
    db.prepare(
      `INSERT INTO worktree_preview_groups (id, session_id, project_id, status)
       VALUES ('g2', 's2', 'p1', 'ready')`,
    ).run();
    db.prepare(
      `INSERT INTO worktree_preview_processes
         (id, group_id, name, pid, port, url, log_path, status)
       VALUES ('p2', 'g2', 'app', 9, 4101, 'http://localhost:4101', NULL, 'ready')`,
    ).run();

    expect(reclaimFailedPortHolder(db, 4101)).toBeNull();
  });

  it('kills the recorded pid before releasing its port', () => {
    // Freeing the port without killing the process is how an orphan ends
    // up answering for the next session allocated that number.
    db.prepare(
      `INSERT INTO worktree_preview_groups (id, session_id, project_id, status)
       VALUES ('g3', 's3', 'p1', 'failed')`,
    ).run();
    db.prepare(
      `INSERT INTO worktree_preview_processes
         (id, group_id, name, pid, port, url, log_path, status)
       VALUES ('p3', 'g3', 'entry', 4242, 4102, 'http://localhost:4102', NULL, 'failed')`,
    ).run();
    const killed: number[] = [];

    const result = reclaimFailedPortHolder(db, 4102, (pid) => killed.push(pid));

    expect(killed).toEqual([4242]);
    expect(result).toEqual({ groupId: 'g3', groupDeleted: true });
  });

  it('still reclaims when the row has no recorded pid', () => {
    db.prepare(
      `INSERT INTO worktree_preview_groups (id, session_id, project_id, status)
       VALUES ('g4', 's4', 'p1', 'failed')`,
    ).run();
    db.prepare(
      `INSERT INTO worktree_preview_processes
         (id, group_id, name, pid, port, url, log_path, status)
       VALUES ('p4', 'g4', 'entry', NULL, 4103, 'http://localhost:4103', NULL, 'failed')`,
    ).run();
    const killed: number[] = [];

    expect(reclaimFailedPortHolder(db, 4103, (pid) => killed.push(pid))).not.toBeNull();
    expect(killed).toEqual([]);
  });

  it('reclaimFailedPortsInRange bulk-deletes failed holders', () => {
    for (const port of [4800, 4801]) {
      const gid = `g-${port}`;
      db.prepare(
        `INSERT INTO worktree_preview_groups (id, session_id, project_id, status)
         VALUES (?, 's', 'p1', 'failed')`,
      ).run(gid);
      db.prepare(
        `INSERT INTO worktree_preview_processes
           (id, group_id, name, pid, port, url, log_path, status)
         VALUES (?, ?, 'entry', NULL, ?, ?, NULL, 'failed')`,
      ).run(`p-${port}`, gid, port, `http://localhost:${port}`);
    }

    expect(reclaimFailedPortsInRange(db, 4800, 4801)).toBe(2);
    expect(
      (
        db
          .prepare(
            `SELECT COUNT(*) AS n FROM worktree_preview_processes WHERE port BETWEEN 4800 AND 4801`,
          )
          .get() as { n: number }
      ).n,
    ).toBe(0);
  });
});
