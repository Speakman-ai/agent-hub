import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { WORKTREE_PREVIEW_GROUPS_SCHEMA } from './preview-schema.js';
import { reconcileStartupOrphanComposeProjects } from './preview-startup-reconcile.js';

function createDb() {
  const db = new Database(':memory:');
  db.exec(WORKTREE_PREVIEW_GROUPS_SCHEMA);
  return db;
}

describe('reconcileStartupOrphanComposeProjects', () => {
  it('removes docker resources for orphan compose projects and keeps tracked ones', () => {
    const db = createDb();
    db.prepare(
      `INSERT INTO worktree_preview_groups (id, session_id, project_id, status, compose_project_name)
       VALUES ('g1', 'sess-tracked', 'proj-1', 'ready', 'agenthub-session-sess-tracked')`,
    ).run();

    const calls: Array<{ cmd: string; args: string[] }> = [];
    const spawnSyncFn = ((cmd: string, args: string[]) => {
      calls.push({ cmd, args: [...args] });
      const full = `${cmd} ${args.join(' ')}`;
      if (full.includes('docker ps -a')) {
        return {
          status: 0,
          stdout: 'agenthub-session-sess-tracked\nagenthub-session-sess-orphan\n',
          stderr: '',
        };
      }
      if (full.includes('docker ps -aq') && full.includes('sess-orphan')) {
        return { status: 0, stdout: 'c1\nc2\n', stderr: '' };
      }
      if (full.includes('docker rm -f c1 c2')) {
        return { status: 0, stdout: '', stderr: '' };
      }
      if (full.includes('docker network ls -q') && full.includes('sess-orphan')) {
        return { status: 0, stdout: 'n1\n', stderr: '' };
      }
      if (full.includes('docker network rm n1')) {
        return { status: 0, stdout: '', stderr: '' };
      }
      if (full.includes('docker volume ls -q') && full.includes('sess-orphan')) {
        return { status: 0, stdout: 'v1\n', stderr: '' };
      }
      if (full.includes('docker volume rm -f v1')) {
        return { status: 0, stdout: '', stderr: '' };
      }
      if (full.includes('docker volume rm -f agenthub-session-sess-orphan_preview-postgres-data')) {
        return { status: 0, stdout: '', stderr: '' };
      }
      if (
        full.includes(
          'docker volume rm -f agenthub-session-sess-orphan_preview-frontend-node-modules',
        )
      ) {
        return { status: 0, stdout: '', stderr: '' };
      }
      return { status: 0, stdout: '', stderr: '' };
    }) as unknown as typeof import('child_process').spawnSync;

    const result = reconcileStartupOrphanComposeProjects({
      db,
      spawnSyncFn,
      logger: { log: () => {}, warn: () => {} },
    });

    expect(result.orphanProjects).toBe(1);
    expect(result.removedProjects).toBe(1);
    expect(result.failedProjects).toBe(0);
    expect(
      calls.some(
        (c) =>
          c.cmd === 'docker' &&
          c.args[0] === 'volume' &&
          c.args[1] === 'rm' &&
          c.args.some((arg) => arg.includes('agenthub-session-sess-orphan')),
      ),
    ).toBe(true);
  });

  it('does nothing when docker list fails', () => {
    const db = createDb();
    const spawnSyncFn = (() => {
      return { status: 1, stdout: '', stderr: 'docker not available' };
    }) as unknown as typeof import('child_process').spawnSync;

    const result = reconcileStartupOrphanComposeProjects({
      db,
      spawnSyncFn,
      logger: { log: () => {}, warn: () => {} },
    });

    expect(result.liveProjects).toBe(0);
    expect(result.orphanProjects).toBe(0);
    expect(result.removedProjects).toBe(0);
  });
});
