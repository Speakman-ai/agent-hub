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

import { mkdirSync, writeFileSync, rmSync, existsSync, utimesSync, mkdtempSync } from 'fs';
import path from 'path';
import os from 'os';
import { homedir } from 'os';
import { v4 as uuidv4 } from 'uuid';

import { getDb, getStmts } from './db.js';
import { WORKSPACES_ROOT, removeWorkspace, cleanupStaleWorkspaces } from './worktree.js';
import {
  purgeExpiredArchivedSessions,
  cleanupAllProjectWorkspaces,
  pruneOrphanedSessionEvents,
  runWorkspacePurge,
  forgetPersistedFirecrackerDisksForPurge,
  type PurgeDeps,
} from './session-purge.js';
import { sessionVmId } from './session-env/firecracker/firecracker-vm-args.js';
import { browserScreenshotDirForSession } from './browser-screenshot-store.js';
import config from './config.js';
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

function depsFor(projectCwd: string, overrides: Partial<PurgeDeps> = {}): PurgeDeps {
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
    // Production forget talks to a privileged helper; tests stub success so
    // row deletion stays under test without a Firecracker host.
    forgetPersistedFirecrackerDisks: async () => {},
    ...overrides,
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

  it('removes both row and worktree for an archived session past 24 hours', async () => {
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

    const result = await purgeExpiredArchivedSessions(depsFor(fixture.projectCwd));

    expect(result.rowsDeleted).toBe(1);
    expect(result.workspacesRemoved).toBe(1);
    expect(existsSync(worktreePath)).toBe(false);

    const stillThere = getDb().prepare('SELECT 1 FROM sessions WHERE id = ?').get(id);
    expect(stillThere).toBeUndefined();
  });

  it('removes the session browser-screenshot directory on hard delete', async () => {
    const { id } = makeSession(fixture.workspaceDir, {
      deletedAtSql: "datetime('now', '-25 hours')",
    });
    getDb()
      .prepare("UPDATE sessions SET deleted_at = datetime('now', '-25 hours') WHERE id = ?")
      .run(id);

    // Captures for this session, and a live sibling that must survive.
    const shotDir = browserScreenshotDirForSession(id, config.dataDir)!;
    const siblingDir = browserScreenshotDirForSession('live-sibling', config.dataDir)!;
    for (const dir of [shotDir, siblingDir]) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, 'browser-1.jpg'), Buffer.alloc(64, 1));
    }

    await purgeExpiredArchivedSessions(depsFor(fixture.projectCwd));

    expect(existsSync(shotDir)).toBe(false);
    expect(existsSync(siblingDir)).toBe(true);
    rmSync(siblingDir, { recursive: true, force: true });
  });

  it('leaves an archived-but-within-24h session untouched', async () => {
    const { id, worktreePath } = makeSession(fixture.workspaceDir, {
      deletedAtSql: "datetime('now', '-6 hours')",
    });
    getDb()
      .prepare("UPDATE sessions SET deleted_at = datetime('now', '-6 hours') WHERE id = ?")
      .run(id);

    const result = await purgeExpiredArchivedSessions(depsFor(fixture.projectCwd));

    expect(result.rowsDeleted).toBe(0);
    expect(existsSync(worktreePath)).toBe(true);
    expect(getDb().prepare('SELECT 1 FROM sessions WHERE id = ?').get(id)).toBeDefined();
  });

  it('leaves a live (non-archived) session untouched', async () => {
    const { id, worktreePath } = makeSession(fixture.workspaceDir, { deletedAtSql: null });

    const result = await purgeExpiredArchivedSessions(depsFor(fixture.projectCwd));

    expect(result.rowsDeleted).toBe(0);
    expect(existsSync(worktreePath)).toBe(true);
    expect(getDb().prepare('SELECT 1 FROM sessions WHERE id = ?').get(id)).toBeDefined();
  });

  it('keeps the row when Firecracker disk forget fails so purge can retry', async () => {
    const { id, worktreePath } = makeSession(fixture.workspaceDir, {
      deletedAtSql: "datetime('now', '-25 hours')",
    });
    getDb()
      .prepare("UPDATE sessions SET deleted_at = datetime('now', '-25 hours') WHERE id = ?")
      .run(id);

    const result = await purgeExpiredArchivedSessions(
      depsFor(fixture.projectCwd, {
        forgetPersistedFirecrackerDisks: async () => {
          throw new Error('helper unavailable');
        },
      }),
    );

    expect(result.rowsDeleted).toBe(0);
    expect(existsSync(worktreePath)).toBe(true);
    expect(getDb().prepare('SELECT 1 FROM sessions WHERE id = ?').get(id)).toBeDefined();
  });

  it('still hard-deletes host/sysbox sessions when no Firecracker artifact exists', async () => {
    // Regression: invoking the FC helper for every purge failed on non-FC
    // installs and left archived rows forever. Default forget is a no-op when
    // the vm dir is absent; the stub here mirrors that success path.
    const { id, worktreePath } = makeSession(fixture.workspaceDir, {
      deletedAtSql: "datetime('now', '-25 hours')",
    });
    getDb()
      .prepare("UPDATE sessions SET deleted_at = datetime('now', '-25 hours') WHERE id = ?")
      .run(id);

    const result = await purgeExpiredArchivedSessions(depsFor(fixture.projectCwd));
    expect(result.rowsDeleted).toBe(1);
    expect(existsSync(worktreePath)).toBe(false);
    expect(getDb().prepare('SELECT 1 FROM sessions WHERE id = ?').get(id)).toBeUndefined();
  });
});

describe('forgetPersistedFirecrackerDisksForPurge gating', () => {
  it('is a no-op when no vm artifact exists', async () => {
    const base = mkdtempSync(path.join(os.tmpdir(), 'fc-purge-absent-'));
    const prevRun = process.env.AGENT_HUB_FIRECRACKER_RUN_DIR;
    try {
      process.env.AGENT_HUB_FIRECRACKER_RUN_DIR = path.join(base, 'vms');
      mkdirSync(process.env.AGENT_HUB_FIRECRACKER_RUN_DIR, { recursive: true });
      await expect(
        forgetPersistedFirecrackerDisksForPurge('sess-no-disk'),
      ).resolves.toBeUndefined();
    } finally {
      if (prevRun === undefined) delete process.env.AGENT_HUB_FIRECRACKER_RUN_DIR;
      else process.env.AGENT_HUB_FIRECRACKER_RUN_DIR = prevRun;
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('fails closed when a vm artifact exists but the local helper is missing', async () => {
    const base = mkdtempSync(path.join(os.tmpdir(), 'fc-purge-gate-'));
    const runDir = path.join(base, 'vms');
    mkdirSync(runDir, { recursive: true });
    const prevRun = process.env.AGENT_HUB_FIRECRACKER_RUN_DIR;
    const prevHelper = process.env.AGENT_HUB_FIRECRACKER_DISK_HELPER;
    const prevMode = process.env.AGENT_HUB_FIRECRACKER_EXEC_MODE;
    const prevImage = process.env.AGENT_HUB_FIRECRACKER_PRIVILEGED_IMAGE;
    try {
      process.env.AGENT_HUB_FIRECRACKER_RUN_DIR = runDir;
      process.env.AGENT_HUB_FIRECRACKER_EXEC_MODE = 'local';
      delete process.env.AGENT_HUB_FIRECRACKER_PRIVILEGED_IMAGE;
      process.env.AGENT_HUB_FIRECRACKER_DISK_HELPER = path.join(
        base,
        'missing-fc-prepare-disks.sh',
      );
      mkdirSync(path.join(runDir, sessionVmId('sess-orphan-disk')), { recursive: true });

      await expect(forgetPersistedFirecrackerDisksForPurge('sess-orphan-disk')).rejects.toThrow(
        /helper .* is missing/,
      );
    } finally {
      if (prevRun === undefined) delete process.env.AGENT_HUB_FIRECRACKER_RUN_DIR;
      else process.env.AGENT_HUB_FIRECRACKER_RUN_DIR = prevRun;
      if (prevHelper === undefined) delete process.env.AGENT_HUB_FIRECRACKER_DISK_HELPER;
      else process.env.AGENT_HUB_FIRECRACKER_DISK_HELPER = prevHelper;
      if (prevMode === undefined) delete process.env.AGENT_HUB_FIRECRACKER_EXEC_MODE;
      else process.env.AGENT_HUB_FIRECRACKER_EXEC_MODE = prevMode;
      if (prevImage === undefined) delete process.env.AGENT_HUB_FIRECRACKER_PRIVILEGED_IMAGE;
      else process.env.AGENT_HUB_FIRECRACKER_PRIVILEGED_IMAGE = prevImage;
      rmSync(base, { recursive: true, force: true });
    }
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

  it('removes orphan session-* dirs with no matching DB row', async () => {
    // No DB row — straight onto disk
    const orphanDir = path.join(fixture.workspaceDir, 'session-deadbeef');
    mkdirSync(orphanDir, { recursive: true });
    writeFileSync(path.join(orphanDir, 'README'), 'orphan\n');
    expect(existsSync(orphanDir)).toBe(true);

    await cleanupAllProjectWorkspaces(depsFor(fixture.projectCwd));

    expect(existsSync(orphanDir)).toBe(false);
  });

  it('preserves a live session dir even if mtime is ancient', async () => {
    const { worktreePath } = makeSession(fixture.workspaceDir, { deletedAtSql: null });
    // Backdate to 30 days ago — would trip the non-session 24h sweep.
    const old = Date.now() / 1000 - 30 * 24 * 60 * 60;
    utimesSync(worktreePath, old, old);

    await cleanupAllProjectWorkspaces(depsFor(fixture.projectCwd));

    expect(existsSync(worktreePath)).toBe(true);
  });

  it('preserves an archived-but-within-24h session', async () => {
    const { id, worktreePath } = makeSession(fixture.workspaceDir, {
      deletedAtSql: "datetime('now', '-3 hours')",
    });
    getDb()
      .prepare("UPDATE sessions SET deleted_at = datetime('now', '-3 hours') WHERE id = ?")
      .run(id);

    await cleanupAllProjectWorkspaces(depsFor(fixture.projectCwd));

    expect(existsSync(worktreePath)).toBe(true);
  });

  it('removes a session-* dir whose row is past the 24h window (defence in depth)', async () => {
    // The purge tick should hard-delete this row first, but if for any
    // reason the row lingers (FK constraint, prior failure), the sweep
    // should still reclaim the disk dir on its own pass.
    const { id, worktreePath } = makeSession(fixture.workspaceDir, {
      deletedAtSql: "datetime('now', '-30 hours')",
    });
    getDb()
      .prepare("UPDATE sessions SET deleted_at = datetime('now', '-30 hours') WHERE id = ?")
      .run(id);

    await cleanupAllProjectWorkspaces(depsFor(fixture.projectCwd));

    expect(existsSync(worktreePath)).toBe(false);
  });

  it('reclaims non-session clones older than 24h', async () => {
    const cronDir = path.join(fixture.workspaceDir, 'cron-stale');
    mkdirSync(cronDir, { recursive: true });
    const old = Date.now() / 1000 - 25 * 60 * 60;
    utimesSync(cronDir, old, old);

    await cleanupAllProjectWorkspaces(depsFor(fixture.projectCwd));

    expect(existsSync(cronDir)).toBe(false);
  });

  it('preserves non-session clones younger than 24h', async () => {
    const cronDir = path.join(fixture.workspaceDir, 'cron-fresh');
    mkdirSync(cronDir, { recursive: true });
    // Default mtime ≈ now → well within 24h.

    await cleanupAllProjectWorkspaces(depsFor(fixture.projectCwd));

    expect(existsSync(cronDir)).toBe(true);
  });
});

describe('pruneOrphanedSessionEvents', () => {
  let fixture: ReturnType<typeof makeProjectFixture>;

  beforeEach(() => {
    fixture = makeProjectFixture();
  });

  afterEach(() => {
    fixture.cleanup();
  });

  it('removes session_events whose parent message was hard-deleted', () => {
    const db = getDb();
    const stmts = getStmts();

    // Create a live session with one message + 2 events. The events
    // should survive the sweep.
    const liveSession = makeSession(fixture.workspaceDir, { deletedAtSql: null });
    const liveMsgId = `msg-${liveSession.id.slice(0, 8)}`;
    db.prepare(`INSERT INTO messages (id, session_id, role, content) VALUES (?, ?, ?, ?)`).run(
      liveMsgId,
      liveSession.id,
      'assistant',
      'live',
    );
    stmts.addSessionEvent.run('message', liveMsgId, 1, 'tool_use', '{}');
    stmts.addSessionEvent.run('message', liveMsgId, 2, 'tool_result', '{}');

    // Insert orphan events directly (parent_id pointing at a message
    // that never existed — simulating post-cascade-delete state).
    stmts.addSessionEvent.run('message', 'msg-ghost', 1, 'assistant_text', '{}');
    stmts.addSessionEvent.run('message', 'msg-ghost', 2, 'tool_result', '{}');
    stmts.addSessionEvent.run('message', 'msg-ghost', 3, 'tool_result', '{}');

    pruneOrphanedSessionEvents(depsFor(fixture.projectCwd));

    const remaining = db.prepare('SELECT parent_id FROM session_events ORDER BY id').all() as {
      parent_id: string;
    }[];
    expect(remaining.map((r) => r.parent_id)).toEqual([liveMsgId, liveMsgId]);
  });

  it('runWorkspacePurge cascades: archived-session delete then orphan sweep in one tick', async () => {
    const db = getDb();
    const stmts = getStmts();

    // Archived session past the 24h window.
    const expiredAt = new Date(Date.now() - 25 * 60 * 60 * 1000)
      .toISOString()
      .replace('T', ' ')
      .slice(0, 19);
    const archived = makeSession(fixture.workspaceDir, { deletedAtSql: expiredAt });

    // Add a message + events. After purgeExpiredArchivedSessions runs,
    // FK CASCADE deletes the message but session_events stay (no FK).
    // The orphan sweep should clean them up in the same tick.
    const archivedMsgId = `msg-${archived.id.slice(0, 8)}`;
    db.prepare(`INSERT INTO messages (id, session_id, role, content) VALUES (?, ?, ?, ?)`).run(
      archivedMsgId,
      archived.id,
      'user',
      'goodbye',
    );
    stmts.addSessionEvent.run('message', archivedMsgId, 1, 'tool_use', '{}');
    stmts.addSessionEvent.run('message', archivedMsgId, 2, 'tool_result', '{}');

    await runWorkspacePurge(depsFor(fixture.projectCwd));

    // Session row gone.
    const sessionRow = db.prepare('SELECT id FROM sessions WHERE id = ?').get(archived.id);
    expect(sessionRow).toBeUndefined();
    // Cascade dropped the message.
    const msgRow = db.prepare('SELECT id FROM messages WHERE id = ?').get(archivedMsgId);
    expect(msgRow).toBeUndefined();
    // Orphan sweep dropped the events.
    const eventRows = db
      .prepare('SELECT COUNT(*) AS n FROM session_events WHERE parent_id = ?')
      .get(archivedMsgId) as { n: number };
    expect(eventRows.n).toBe(0);
  });

  it('runWorkspacePurge sweeps aged orphan screenshot dirs with no session row', async () => {
    // A capture dir whose session row vanished without passing through the
    // hard-delete path has no other collector — the tick's sweep is it.
    const orphanDir = browserScreenshotDirForSession('orphan-shots', config.dataDir)!;
    const freshDir = browserScreenshotDirForSession('fresh-shots', config.dataDir)!;
    for (const dir of [orphanDir, freshDir]) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, 'browser-1.jpg'), Buffer.alloc(64, 1));
    }
    // Age the orphan past the retention window.
    const old = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    utimesSync(path.join(orphanDir, 'browser-1.jpg'), old, old);

    await runWorkspacePurge(depsFor(fixture.projectCwd));

    expect(existsSync(orphanDir)).toBe(false);
    expect(existsSync(freshDir)).toBe(true);
    rmSync(freshDir, { recursive: true, force: true });
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
