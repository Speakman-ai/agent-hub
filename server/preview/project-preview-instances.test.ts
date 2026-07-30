import { describe, expect, it, vi, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { WORKTREE_PREVIEW_GROUPS_SCHEMA } from './preview-schema.js';
import {
  listProjectPreviewInstances,
  purgeProjectPreviewInstances,
  stopProjectPreviewInstance,
} from './project-preview-instances.js';

function openDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(WORKTREE_PREVIEW_GROUPS_SCHEMA);
  db.exec(`CREATE TABLE sessions (id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, name TEXT)`);
  return db;
}

describe('project-preview-instances', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = openDb();
    db.prepare(`INSERT INTO sessions (id, agent_id, name) VALUES (?, ?, ?)`).run(
      's1',
      'a1',
      'Session',
    );
    db.prepare(
      `INSERT INTO worktree_preview_groups (id, session_id, project_id, status) VALUES (?, ?, ?, ?)`,
    ).run('g1', 's1', 'p1', 'ready');
    db.prepare(
      `INSERT INTO worktree_preview_processes (id, group_id, name, port, url, status, is_primary) VALUES (?, ?, ?, ?, ?, ?, 1)`,
    ).run('g1:web', 'g1', 'web', 4100, 'http://localhost:4100', 'ready');
  });

  it('lists the primary port for active groups', () => {
    expect(listProjectPreviewInstances(db, 'p1').previews[0]).toMatchObject({
      id: 'g1',
      sessionId: 's1',
      agentId: 'a1',
      sessionName: 'Session',
      status: 'ready',
      port: 4100,
    });
  });

  it('stops one group through the dev-server runtime', async () => {
    const stop = vi.fn().mockResolvedValue(undefined);
    const result = await stopProjectPreviewInstance(
      db,
      { getDevServerRuntime: () => ({ stop }) as never },
      'p1',
      'g1',
    );
    expect(result.stopped).toBe(true);
    expect(stop).toHaveBeenCalledWith('g1');
  });

  it('purges every group and reports runtime failures', async () => {
    const stop = vi.fn().mockResolvedValue(undefined);
    const result = await purgeProjectPreviewInstances(
      db,
      { getDevServerRuntime: () => ({ stop }) as never },
      'p1',
    );
    expect(result).toEqual({ ok: true, stopped: 1, failed: [] });
  });
});
