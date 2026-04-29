/**
 * Tests for the hourly session-purge tick:
 *
 * - archived-then-24h-old session: row + worktree both removed.
 * - live session: untouched even if its dir mtime is old.
 * - session-* dir on disk with no matching DB row at all (orphan): removed.
 * - archived-but-within-24h: untouched.
 * - WORKSPACES_ROOT safety check still rejects paths outside the managed root.
 *
 * The shared `test/setup.ts` harness wires `AGENT_HUB_DATA_DIR` to a
 * `tmp/agent-hub-test-<pid>/` directory and inits the production `db` /
 * `stmts` against it, so we can drive realistic DB rows through the
 * purge path. Workspace dirs live under the real
 * `~/.agent-hub/workspaces/` (the only path `cleanupStaleWorkspaces`
 * accepts) inside a uniquely-named project slug per test so we never
 * collide with another worktree on the same host.
 */
import './test/setup.js';

import { mkdirSync, writeFileSync, rmSync, existsSync, utimesSync } from 'fs';
import path from 'path';
import os from 'os';
import { homedir } from 'os';
import { v4 as uuidv4 } from 'uuid';

import { getDb, getStmts } from './db.js';
import { WORKSPACES_ROOT, removeWorkspace, cleanupStaleWorkspaces } from './worktree.js';
import {
  purgeExpiredArchivedSessions,
  cleanupAllProjectWorkspaces,
  type PurgeDeps,
} from './session-purge.js';
import type { Project } from './types.js';

function projectSlugFor(cwd: string): string {
  return path.basename(cwd).replace(/[^a-zA-Z0-9_-]/g, '-');
}

/**
 * Build a fresh project directory + matching workspace dir under
 * `~/.agent-hub/workspaces/`. Returns absolute paths and a cleanup
 * function that scrubs both. The project cwd lives in `tmpdir()` (we
 * never write under WORKSPACES_ROOT outside the workspace dir), so the
 * `projectSlug()` stays unique per test.
 */
function makeProjectFixture(): {
  projectCwd: string;
  workspaceDir: string;
  cleanup: () => void;
} {
  const slug = `agent-hub-purge-test-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  const projectCwd = path.join(os.tmpdir(), slug);
  mkdirSync(projectCwd, { recursive: true });
  const workspaceDir = path.join(WORKSPACES_ROOT, projectSlugFor(projectCwd));
  mkdirSync(workspaceDir, { recursive: true });
  return {
    projectCwd,
    workspaceDir,
    cleanup: () => {
      try {
        if (existsSync(workspaceDir)) rmSync(workspaceDir, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
      try {
        if (existsSync(projectCwd)) rmSync(projectCwd, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
    },
  };
}

/**
 * Insert a session row with the given `deleted_at` literal (ISO-shaped
 * SQLite text or null). `worktree_path` is wired so the purge can find
 * the clone and `removeWorkspace` will accept it (must live under
 * `WORKSPACES_ROOT`).
 *
 * Returns the row id and the on-disk clone path.
 */
function makeSession(
  workspaceDir: string,
  opts: { deletedAtSql: string | null; idPrefix?: string } = { deletedAtSql: null },
): { id: string; worktreePath: string } {
  const id = (opts.idPrefix ?? uuidv4().replace(/-/g, '').slice(0, 8)) + uuidv4().slice(8);
  const shortId = id.slice(0, 8);
  const worktreePath = path.join(workspaceDir, `session-${shortId}`);
  mkdirSync(worktreePath, { recursive: true });
  writeFileSync(path.join(worktreePath, 'README'), `session ${id}\n`);

  // INSERT with a deterministic deleted_at so we don't have to sleep in
  // tests. The schema has plenty of NOT NULL columns; getStmts.createSession
  // is the same path the real server uses, but it doesn't accept a
  // deleted_at — so use a raw INSERT.
  const db = getDb();
  db.prepare(
    `INSERT INTO sessions (id, agent_id, name, engine, model, use_worktree, worktree_path, created_at, updated_at, deleted_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'), ?)`,
  ).run(
    id,
    'test-agent',
    `t-${shortId}`,
    'claude',
    'claude-sonnet-4-20250514',
    1,
    worktreePath,
    opts.deletedAtSql,
  );

  return { id, worktreePath };
}

function depsFor(projectCwd: string): PurgeDeps {
  return {
    db: getDb(),
    stmts: getStmts(),
    getProjects: () => [
      {
        id: 'test-project',
        name: 'Test Project',
        cwd: projectCwd,
        color: '#000',
      } as Project,
    ],
    removeWorkspace,
    cleanupStaleWorkspaces,
  };
}

describe('purgeExpiredArchivedSessions', () => {
  let fixture: ReturnType<typeof makeProjectFixture>;

  beforeEach(() => {
    fixture = makeProjectFixture();
  });

  afterEach(() => {
    fixture.cleanup();
    // Wipe any session rows the test inserted so other suites stay clean.
    try {
      getDb().prepare("DELETE FROM sessions WHERE agent_id = 'test-agent'").run();
    } catch {
      /* best-effort */
    }
  });

  it('removes both row and worktree for an archived session past 24 hours', () => {
    const { id, worktreePath } = makeSession(fixture.workspaceDir, {
      deletedAtSql: "datetime('now', '-25 hours')",
    });

    // The makeSession helper had to use raw SQL because deleted_at can
    // be `datetime(...)` SQL expression; emulate it by re-running the
    // update so the row carries an actual past timestamp.
    getDb()
      .prepare("UPDATE sessions SET deleted_at = datetime('now', '-25 hours') WHERE id = ?")
      .run(id);

    expect(existsSync(worktreePath)).toBe(true);

    const result = purgeExpiredArchivedSessions(depsFor(fixture.projectCwd));

    expect(result.rowsDeleted).toBe(1);
    expect(result.workspacesRemoved).toBe(1);
    expect(existsSync(worktreePath)).toBe(false);

    const stillThere = getDb().prepare('SELECT 1 FROM sessions WHERE id = ?').get(id);
    expect(stillThere).toBeUndefined();
  });

  it('leaves an archived-but-within-24h session untouched', () => {
    const { id, worktreePath } = makeSession(fixture.workspaceDir, {
      deletedAtSql: "datetime('now', '-6 hours')",
    });
    getDb()
      .prepare("UPDATE sessions SET deleted_at = datetime('now', '-6 hours') WHERE id = ?")
      .run(id);

    const result = purgeExpiredArchivedSessions(depsFor(fixture.projectCwd));

    expect(result.rowsDeleted).toBe(0);
    expect(existsSync(worktreePath)).toBe(true);
    expect(getDb().prepare('SELECT 1 FROM sessions WHERE id = ?').get(id)).toBeDefined();
  });

  it('leaves a live (non-archived) session untouched', () => {
    const { id, worktreePath } = makeSession(fixture.workspaceDir, { deletedAtSql: null });

    const result = purgeExpiredArchivedSessions(depsFor(fixture.projectCwd));

    expect(result.rowsDeleted).toBe(0);
    expect(existsSync(worktreePath)).toBe(true);
    expect(getDb().prepare('SELECT 1 FROM sessions WHERE id = ?').get(id)).toBeDefined();
  });
});

describe('cleanupAllProjectWorkspaces', () => {
  let fixture: ReturnType<typeof makeProjectFixture>;

  beforeEach(() => {
    fixture = makeProjectFixture();
  });

  afterEach(() => {
    fixture.cleanup();
    try {
      getDb().prepare("DELETE FROM sessions WHERE agent_id = 'test-agent'").run();
    } catch {
      /* best-effort */
    }
  });

  it('removes orphan session-* dirs with no matching DB row', () => {
    // No DB row — straight onto disk
    const orphanDir = path.join(fixture.workspaceDir, 'session-deadbeef');
    mkdirSync(orphanDir, { recursive: true });
    writeFileSync(path.join(orphanDir, 'README'), 'orphan\n');
    expect(existsSync(orphanDir)).toBe(true);

    cleanupAllProjectWorkspaces(depsFor(fixture.projectCwd));

    expect(existsSync(orphanDir)).toBe(false);
  });

  it('preserves a live session dir even if mtime is ancient', () => {
    const { worktreePath } = makeSession(fixture.workspaceDir, { deletedAtSql: null });
    // Backdate to 30 days ago — would trip the non-session 24h sweep.
    const old = Date.now() / 1000 - 30 * 24 * 60 * 60;
    utimesSync(worktreePath, old, old);

    cleanupAllProjectWorkspaces(depsFor(fixture.projectCwd));

    expect(existsSync(worktreePath)).toBe(true);
  });

  it('preserves an archived-but-within-24h session', () => {
    const { id, worktreePath } = makeSession(fixture.workspaceDir, {
      deletedAtSql: "datetime('now', '-3 hours')",
    });
    getDb()
      .prepare("UPDATE sessions SET deleted_at = datetime('now', '-3 hours') WHERE id = ?")
      .run(id);

    cleanupAllProjectWorkspaces(depsFor(fixture.projectCwd));

    expect(existsSync(worktreePath)).toBe(true);
  });

  it('removes a session-* dir whose row is past the 24h window (defence in depth)', () => {
    // The purge tick should hard-delete this row first, but if for any
    // reason the row lingers (FK constraint, prior failure), the sweep
    // should still reclaim the disk dir on its own pass.
    const { id, worktreePath } = makeSession(fixture.workspaceDir, {
      deletedAtSql: "datetime('now', '-30 hours')",
    });
    getDb()
      .prepare("UPDATE sessions SET deleted_at = datetime('now', '-30 hours') WHERE id = ?")
      .run(id);

    cleanupAllProjectWorkspaces(depsFor(fixture.projectCwd));

    expect(existsSync(worktreePath)).toBe(false);
  });

  it('reclaims non-session clones older than 24h', () => {
    const cronDir = path.join(fixture.workspaceDir, 'cron-stale');
    mkdirSync(cronDir, { recursive: true });
    const old = Date.now() / 1000 - 25 * 60 * 60;
    utimesSync(cronDir, old, old);

    cleanupAllProjectWorkspaces(depsFor(fixture.projectCwd));

    expect(existsSync(cronDir)).toBe(false);
  });

  it('preserves non-session clones younger than 24h', () => {
    const cronDir = path.join(fixture.workspaceDir, 'cron-fresh');
    mkdirSync(cronDir, { recursive: true });
    // Default mtime ≈ now → well within 24h.

    cleanupAllProjectWorkspaces(depsFor(fixture.projectCwd));

    expect(existsSync(cronDir)).toBe(true);
  });
});

describe('removeWorkspace — WORKSPACES_ROOT safety check', () => {
  it('refuses to remove a path outside the managed root', () => {
    // Create a sentinel under tmpdir() (not WORKSPACES_ROOT) and assert
    // removeWorkspace leaves it untouched. Anything under
    // WORKSPACES_ROOT would be valid; we want the *negative* case.
    const outside = path.join(
      os.tmpdir(),
      `agent-hub-purge-outside-${process.pid}-${Math.random().toString(36).slice(2, 6)}`,
    );
    mkdirSync(outside, { recursive: true });
    writeFileSync(path.join(outside, 'sentinel'), 'do not delete\n');
    expect(outside.startsWith(homedir())).toBe(false);

    try {
      removeWorkspace(outside);
      expect(existsSync(outside)).toBe(true);
      expect(existsSync(path.join(outside, 'sentinel'))).toBe(true);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('removes a path inside WORKSPACES_ROOT', () => {
    const inside = path.join(
      WORKSPACES_ROOT,
      `agent-hub-purge-inside-${process.pid}-${Math.random().toString(36).slice(2, 6)}`,
    );
    mkdirSync(inside, { recursive: true });
    writeFileSync(path.join(inside, 'sentinel'), 'remove me\n');

    removeWorkspace(inside);
    expect(existsSync(inside)).toBe(false);
  });
});
