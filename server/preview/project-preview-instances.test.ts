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

  describe('dev-server groups', () => {
    beforeEach(() => {
      db.prepare(`INSERT INTO sessions (id, agent_id, name) VALUES (?, ?, ?)`).run(
        'sess-2',
        'agent-1',
        'Dev server session',
      );
      // A dev-server group carries runtime='dev-server' and NULL
      // compose_project_name, and names its process rows after the
      // project's portMap keys rather than 'entry'.
      db.prepare(
        `INSERT INTO worktree_preview_groups
           (id, session_id, project_id, status, compose_project_name, runtime, worktree_path)
         VALUES (?, ?, ?, ?, NULL, 'dev-server', ?)`,
      ).run('g2', 'sess-2', 'proj-a', 'ready', '/tmp/wt2');
      db.prepare(
        `INSERT INTO worktree_preview_processes
           (id, group_id, name, port, url, status, internal_port, is_primary)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run('g2:client', 'g2', 'client', 4200, 'http://localhost:4200', 'ready', 3050, 1);
      db.prepare(
        `INSERT INTO worktree_preview_processes
           (id, group_id, name, port, url, status, internal_port, is_primary)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run('g2:api', 'g2', 'api', 4201, 'http://localhost:4201', 'ready', 3051, 0);
    });

    it("lists dev-server groups with kind 'dev-server' and the primary port", () => {
      const { previews } = listProjectPreviewInstances(db, 'proj-a');
      const devServer = previews.find((p) => p.id === 'g2');
      expect(devServer).toMatchObject({
        id: 'g2',
        sessionId: 'sess-2',
        sessionName: 'Dev server session',
        status: 'ready',
        kind: 'dev-server',
        composeProjectName: null,
        port: 4200,
        url: 'http://localhost:4200',
      });
      // The extra portMap row must not fan the group out into two entries.
      expect(previews.filter((p) => p.id === 'g2')).toHaveLength(1);
    });

    it('stopProjectPreviewInstance routes dev-server groups to DevServerRuntime.stop', async () => {
      const stop = vi.fn().mockResolvedValue(undefined);
      const stopPreview = vi.fn().mockResolvedValue(undefined);
      const result = await stopProjectPreviewInstance(
        db,
        {
          getDevServerRuntime: () => ({ stop }) as never,
          getPreviewComposeRuntime: () => ({ stopPreview }) as never,
          getPreviewRuntime: () => ({ stopPreview }) as never,
        },
        'proj-a',
        'g2',
      );
      expect(result.stopped).toBe(true);
      expect(stop).toHaveBeenCalledWith('g2');
      // The legacy runtime ignores dev-server rows, so reaching it would
      // report success while leaking the process and its host port.
      expect(stopPreview).not.toHaveBeenCalled();
    });

    it('stopProjectPreviewInstance surfaces a missing dev-server runtime', async () => {
      await expect(
        stopProjectPreviewInstance(db, { getPreviewRuntime: () => ({}) as never }, 'proj-a', 'g2'),
      ).rejects.toThrow(/Dev server runtime is not available/);
    });

    it('purgeProjectPreviewInstances stops compose and dev-server groups with their own runtimes', async () => {
      const stop = vi.fn().mockResolvedValue(undefined);
      const stopPreview = vi.fn().mockResolvedValue(undefined);
      const result = await purgeProjectPreviewInstances(
        db,
        {
          getDevServerRuntime: () => ({ stop }) as never,
          getPreviewComposeRuntime: () => ({ stopPreview }) as never,
        },
        'proj-a',
      );
      expect(result.stopped).toBe(2);
      expect(result.failed).toEqual([]);
      expect(stop).toHaveBeenCalledWith('g2');
      expect(stopPreview).toHaveBeenCalledWith('g1');
      expect(stopPreview).toHaveBeenCalledTimes(1);
    });
  });
});
