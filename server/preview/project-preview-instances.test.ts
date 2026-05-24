import { describe, it, expect, vi, beforeEach } from 'vitest';
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
  for (const stmt of [
    `ALTER TABLE worktree_preview_groups ADD COLUMN worktree_path TEXT`,
    `ALTER TABLE worktree_preview_groups ADD COLUMN compose_file TEXT`,
    `ALTER TABLE worktree_preview_groups ADD COLUMN entry_port INTEGER`,
    `ALTER TABLE worktree_preview_groups ADD COLUMN override_file_path TEXT`,
    `ALTER TABLE worktree_preview_groups ADD COLUMN host_project_directory TEXT`,
  ]) {
    try {
      db.exec(stmt);
    } catch (err) {
      const msg = (err as Error).message ?? '';
      if (!msg.includes('duplicate column name')) throw err;
    }
  }
  db.exec(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      name TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
  `);
  return db;
}

describe('project-preview-instances', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openDb();
    db.prepare(`INSERT INTO sessions (id, agent_id, name) VALUES (?, ?, ?)`).run(
      'sess-1',
      'agent-1',
      'My session',
    );
    db.prepare(
      `INSERT INTO worktree_preview_groups
         (id, session_id, project_id, status, compose_project_name, worktree_path)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run('g1', 'sess-1', 'proj-a', 'ready', 'agenthub-session-sess-1', '/tmp/wt');
    db.prepare(
      `INSERT INTO worktree_preview_processes
         (id, group_id, name, port, url, status)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run('g1:entry', 'g1', 'entry', 4100, 'http://localhost:4100', 'ready');
  });

  it('lists active groups for the project', () => {
    const { previews } = listProjectPreviewInstances(db, 'proj-a');
    expect(previews).toHaveLength(1);
    expect(previews[0]).toMatchObject({
      id: 'g1',
      sessionId: 'sess-1',
      sessionName: 'My session',
      status: 'ready',
      kind: 'compose',
      port: 4100,
    });
  });

  it('stopProjectPreviewInstance calls compose runtime stopPreview', async () => {
    const stopPreview = vi.fn().mockResolvedValue(undefined);
    const result = await stopProjectPreviewInstance(
      db,
      { getPreviewComposeRuntime: () => ({ stopPreview }) as never },
      'proj-a',
      'g1',
    );
    expect(result.stopped).toBe(true);
    expect(stopPreview).toHaveBeenCalledWith('g1');
  });

  it('purgeProjectPreviewInstances stops every listed group', async () => {
    const stopPreview = vi.fn().mockResolvedValue(undefined);
    const result = await purgeProjectPreviewInstances(
      db,
      { getPreviewComposeRuntime: () => ({ stopPreview }) as never },
      'proj-a',
    );
    expect(result.stopped).toBe(1);
    expect(result.failed).toEqual([]);
    expect(stopPreview).toHaveBeenCalledWith('g1');
  });
});
