import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, existsSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';

import {
  designSessionName,
  mapDesignMessages,
  resolveImportTargetAgentId,
  planDesignImport,
  copyDesignArtifacts,
  importDesignToSession,
  isDesignImportSkip,
  DesignImportError,
  DesignImportInProgressError,
  type ImportCandidateAgent,
  type DesignImportResult,
} from './design-import.js';
import { createDesign, linkProject, ensureDesignsRoot, designDir } from './designs-store.js';
import { setSessionOwner } from './session-ownership.js';
import { getDb, getStmts } from './db.js';
import { wipeTables } from './test/destructive-db.js';
import type { DesignMessageRow, DesignWithProjects, Project, SessionRow } from './types.js';

const projects = new Map<string, Project>();
function lookup(id: string): Project | null {
  return projects.get(id) ?? null;
}
function registerProject(id: string): Project {
  const p: Project = { id, name: `Project ${id}`, cwd: '/tmp', ahw: '/tmp', agents: [] };
  projects.set(id, p);
  return p;
}

let designsRoot: string;

beforeEach(() => {
  designsRoot = mkdtempSync(path.join(tmpdir(), 'design-import-test-'));
  ensureDesignsRoot(designsRoot);
  projects.clear();

  // wipeTables enforces the scratch-DB check (server/test/destructive-db.ts).
  wipeTables(getDb(), ['design_messages', 'design_projects', 'designs', 'messages', 'sessions']);
});

function row(
  role: DesignMessageRow['role'],
  content: string,
  created_at: string,
): DesignMessageRow {
  return { id: `m-${created_at}`, design_id: 'd', role, content, created_at };
}

describe('designSessionName', () => {
  it('prefixes and trims', () => {
    expect(designSessionName('  My Landing Page  ')).toBe('[Design] My Landing Page');
  });

  it('falls back for blank names', () => {
    expect(designSessionName('')).toBe('[Design] Untitled design');
    expect(designSessionName('   ')).toBe('[Design] Untitled design');
  });

  it('truncates to 100 chars', () => {
    const name = designSessionName('x'.repeat(200));
    expect(name.length).toBe(100);
    expect(name.startsWith('[Design] ')).toBe(true);
  });
});

describe('mapDesignMessages', () => {
  it('preserves order, role, content and created_at', () => {
    const out = mapDesignMessages([
      row('user', 'hello', '2026-01-01 00:00:01'),
      row('assistant', 'hi', '2026-01-01 00:00:02'),
      row('system', 'note', '2026-01-01 00:00:03'),
    ]);
    expect(out).toEqual([
      { role: 'user', content: 'hello', created_at: '2026-01-01 00:00:01' },
      { role: 'assistant', content: 'hi', created_at: '2026-01-01 00:00:02' },
      { role: 'system', content: 'note', created_at: '2026-01-01 00:00:03' },
    ]);
  });

  it('drops unknown roles and empty content', () => {
    const out = mapDesignMessages([
      row('user', '', '2026-01-01 00:00:01'),
      { ...row('user', 'ok', '2026-01-01 00:00:02'), role: 'tool' as never },
      row('assistant', 'kept', '2026-01-01 00:00:03'),
    ]);
    expect(out).toEqual([
      { role: 'assistant', content: 'kept', created_at: '2026-01-01 00:00:03' },
    ]);
  });
});

describe('resolveImportTargetAgentId', () => {
  const agents: ImportCandidateAgent[] = [
    { id: 'a-claude', projectId: 'p1', engine: 'claude-code' },
    { id: 'a-cursor', projectId: 'p1', engine: 'cursor-agent' },
    { id: 'a-reviewer', projectId: 'p1', engine: 'claude-code', role: 'reviewer' },
    { id: 'a-other', projectId: 'p2', engine: 'claude-code' },
  ];

  it('returns null when the design links no projects', () => {
    expect(resolveImportTargetAgentId([], agents)).toBeNull();
  });

  it('returns null when no agent is in a linked project', () => {
    expect(resolveImportTargetAgentId(['p3'], agents)).toBeNull();
  });

  it('prefers an engine match in a linked project', () => {
    expect(resolveImportTargetAgentId(['p1'], agents, 'cursor-agent')).toBe('a-cursor');
  });

  it('falls back to the first agent of the first linked project', () => {
    expect(resolveImportTargetAgentId(['p1', 'p2'], agents)).toBe('a-claude');
  });

  it('honours linked-project order for the fallback', () => {
    expect(resolveImportTargetAgentId(['p2', 'p1'], agents)).toBe('a-other');
  });

  it('never selects a reviewer agent', () => {
    const reviewerOnly: ImportCandidateAgent[] = [
      { id: 'rev', projectId: 'p1', engine: 'claude-code', role: 'reviewer' },
    ];
    expect(resolveImportTargetAgentId(['p1'], reviewerOnly)).toBeNull();
  });
});

describe('planDesignImport', () => {
  const design = { id: 'd1', name: 'Cool', imported_session_id: null };

  it('skips an already-imported design', () => {
    const result = planDesignImport({ ...design, imported_session_id: 'sess-1' }, [], {
      targetAgentId: 'a1',
    });
    expect(isDesignImportSkip(result)).toBe(true);
    expect(result).toEqual({ skip: 'already-imported', sessionId: 'sess-1' });
  });

  it('skips when no target agent resolved', () => {
    const result = planDesignImport(design, [], { targetAgentId: null });
    expect(result).toEqual({ skip: 'no-target-agent' });
  });

  it('produces a design-mode plan with mapped messages', () => {
    const result = planDesignImport(design, [row('user', 'hi', '2026-01-01 00:00:01')], {
      targetAgentId: 'a1',
    });
    expect(isDesignImportSkip(result)).toBe(false);
    if (isDesignImportSkip(result)) throw new Error('unreachable');
    expect(result.targetAgentId).toBe('a1');
    expect(result.sessionName).toBe('[Design] Cool');
    expect(result.sessionMode).toBe('design');
    expect(result.messages).toHaveLength(1);
  });
});

describe('copyDesignArtifacts', () => {
  it('copies the artifact dir into <worktree>/design/', () => {
    const id = 'design-x';
    const src = designDir(designsRoot, id);
    mkdirSync(path.join(src, 'assets'), { recursive: true });
    writeFileSync(path.join(src, 'index.html'), '<h1>hi</h1>');
    writeFileSync(path.join(src, 'assets', 'app.js'), 'console.log(1)');

    const worktree = mkdtempSync(path.join(tmpdir(), 'design-import-wt-'));
    copyDesignArtifacts(designsRoot, id, worktree);

    expect(readFileSync(path.join(worktree, 'design', 'index.html'), 'utf-8')).toBe('<h1>hi</h1>');
    expect(existsSync(path.join(worktree, 'design', 'assets', 'app.js'))).toBe(true);
    rmSync(worktree, { recursive: true, force: true });
  });

  it('is a no-op when the source dir is missing', () => {
    const worktree = mkdtempSync(path.join(tmpdir(), 'design-import-wt-'));
    expect(() => copyDesignArtifacts(designsRoot, 'never-existed', worktree)).not.toThrow();
    expect(existsSync(path.join(worktree, 'design'))).toBe(false);
    rmSync(worktree, { recursive: true, force: true });
  });
});

describe('importDesignToSession (executor)', () => {
  function seedDesign(): DesignWithProjects {
    registerProject('p1');
    const design = createDesign('My Site', ['p1'], designsRoot, lookup, 'default');
    linkProject(design.id, 'p1');
    // Seed an artifact and two transcript messages with explicit timestamps.
    writeFileSync(path.join(designDir(designsRoot, design.id), 'index.html'), '<h1>seeded</h1>');
    const stmts = getStmts();
    stmts.appendDesignMessage.run('dm1', design.id, 'user', 'build me a hero');
    getDb()
      .prepare("UPDATE design_messages SET created_at = ? WHERE id = 'dm1'")
      .run('2026-01-01 00:00:01');
    stmts.appendDesignMessage.run('dm2', design.id, 'assistant', 'done');
    getDb()
      .prepare("UPDATE design_messages SET created_at = ? WHERE id = 'dm2'")
      .run('2026-01-01 00:00:02');
    return design;
  }

  function buildDeps(worktree: string, broadcast = vi.fn()) {
    return {
      stmts: getStmts(),
      getDesignsRoot: () => designsRoot,
      provisionSessionWorkspace: vi.fn(async () => worktree),
      resolveEngineModel: () => ({ engine: 'claude-code', model: 'sonnet' }),
      setSessionOwner,
      ownerUserId: 'user-1',
      agents: (): ImportCandidateAgent[] => [
        { id: 'agent-1', projectId: 'p1', engine: 'claude-code' },
      ],
      broadcast,
    };
  }

  it('creates a design-mode session, copies artifacts, replays the transcript', async () => {
    const design = seedDesign();
    const designFull = { ...design, linkedProjects: [lookup('p1')!] };
    const worktree = mkdtempSync(path.join(tmpdir(), 'design-import-exec-'));
    const broadcast = vi.fn();

    const result = await importDesignToSession(
      buildDeps(worktree, broadcast),
      designFull,
      getStmts().listDesignMessages.all(design.id) as DesignMessageRow[],
    );

    expect(result.agentId).toBe('agent-1');
    expect(result.importedMessages).toBe(2);
    expect(result.skipped).toBeUndefined();

    // Session row is design-mode.
    const session = getStmts().getSession.get(result.sessionId) as SessionRow;
    expect(session.session_mode).toBe('design');
    expect(session.agent_id).toBe('agent-1');
    expect(session.name).toBe('[Design] My Site');

    // Artifacts copied into the worktree design/ dir.
    expect(readFileSync(path.join(worktree, 'design', 'index.html'), 'utf-8')).toBe(
      '<h1>seeded</h1>',
    );

    // Transcript replayed in order with original timestamps preserved.
    const msgs = getStmts().getMessages.all(result.sessionId) as Array<{
      role: string;
      content: string;
      created_at: string;
    }>;
    expect(msgs.map((m) => [m.role, m.content, m.created_at])).toEqual([
      ['user', 'build me a hero', '2026-01-01 00:00:01'],
      ['assistant', 'done', '2026-01-01 00:00:02'],
    ]);

    // imported_session_id recorded on the design.
    const updated = getStmts().getDesign.get(design.id) as { imported_session_id: string };
    expect(updated.imported_session_id).toBe(result.sessionId);

    // Broadcasts a session_created and design_imported event.
    const types = broadcast.mock.calls.map((c) => (c[0] as { type: string }).type);
    expect(types).toContain('session_created');
    expect(types).toContain('design_imported');

    rmSync(worktree, { recursive: true, force: true });
  });

  it('preserves transcript order when messages share the same second', async () => {
    registerProject('p1');
    const design = createDesign('Rapid', ['p1'], designsRoot, lookup, 'default');
    linkProject(design.id, 'p1');
    // Six messages, ALL stamped with the same second — only insertion order
    // (rowid) distinguishes them. A created_at-only sort would scramble these.
    const sameSecond = '2026-01-01 00:00:05';
    const seq = ['one', 'two', 'three', 'four', 'five', 'six'];
    seq.forEach((content, i) => {
      const role = i % 2 === 0 ? 'user' : 'assistant';
      getStmts().appendDesignMessage.run(`r${i}`, design.id, role, content);
    });
    getDb()
      .prepare('UPDATE design_messages SET created_at = ? WHERE design_id = ?')
      .run(sameSecond, design.id);

    const worktree = mkdtempSync(path.join(tmpdir(), 'design-import-exec-'));
    const result = await importDesignToSession(
      buildDeps(worktree),
      { ...design, linkedProjects: [lookup('p1')!] },
      getStmts().listDesignMessages.all(design.id) as DesignMessageRow[],
    );

    const replayed = (
      getStmts().getMessages.all(result.sessionId) as Array<{ content: string }>
    ).map((m) => m.content);
    expect(replayed).toEqual(seq);

    rmSync(worktree, { recursive: true, force: true });
  });

  it('is idempotent: re-import returns the existing session', async () => {
    const design = seedDesign();
    const designFull = { ...design, linkedProjects: [lookup('p1')!] };
    const worktree = mkdtempSync(path.join(tmpdir(), 'design-import-exec-'));

    const first = await importDesignToSession(
      buildDeps(worktree),
      designFull,
      getStmts().listDesignMessages.all(design.id) as DesignMessageRow[],
    );

    // Reload the design (now carries imported_session_id) and re-run.
    const reloaded = getStmts().getDesign.get(design.id) as DesignWithProjects;
    const second = await importDesignToSession(
      buildDeps(worktree),
      { ...reloaded, linkedProjects: [lookup('p1')!] },
      getStmts().listDesignMessages.all(design.id) as DesignMessageRow[],
    );

    expect(second.sessionId).toBe(first.sessionId);
    expect(second.skipped).toBe('already-imported');
    expect(second.importedMessages).toBe(0);

    // Only one session created total.
    const count = (getDb().prepare('SELECT COUNT(*) AS n FROM sessions').get() as { n: number }).n;
    expect(count).toBe(1);

    rmSync(worktree, { recursive: true, force: true });
  });

  it('throws DesignImportError when no eligible agent exists', async () => {
    const design = seedDesign();
    const designFull = { ...design, linkedProjects: [lookup('p1')!] };
    const worktree = mkdtempSync(path.join(tmpdir(), 'design-import-exec-'));
    const deps = { ...buildDeps(worktree), agents: (): ImportCandidateAgent[] => [] };

    await expect(importDesignToSession(deps, designFull, [])).rejects.toBeInstanceOf(
      DesignImportError,
    );

    rmSync(worktree, { recursive: true, force: true });
  });

  it('re-imports through a stale imported_session_id (deleted session)', async () => {
    const design = seedDesign();
    const designFull = { ...design, linkedProjects: [lookup('p1')!] };
    const worktree = mkdtempSync(path.join(tmpdir(), 'design-import-exec-'));
    const msgs = getStmts().listDesignMessages.all(design.id) as DesignMessageRow[];

    const first = await importDesignToSession(buildDeps(worktree), designFull, msgs);

    // Simulate the recorded session being deleted out from under the design,
    // leaving a stale pointer. The design still records the (now gone) session.
    getStmts().deleteSession.run(first.sessionId);
    const stale = getStmts().getDesign.get(design.id) as DesignWithProjects;
    expect(stale.imported_session_id).toBe(first.sessionId);

    // Re-import must recover: create a NEW session, not throw 'already-imported'.
    const second = await importDesignToSession(
      buildDeps(worktree),
      { ...stale, linkedProjects: [lookup('p1')!] },
      getStmts().listDesignMessages.all(design.id) as DesignMessageRow[],
    );
    expect(second.skipped).toBeUndefined();
    expect(second.sessionId).not.toBe(first.sessionId);
    expect(second.importedMessages).toBe(2);

    // Pointer now tracks the fresh session, and exactly one session exists.
    const updated = getStmts().getDesign.get(design.id) as { imported_session_id: string };
    expect(updated.imported_session_id).toBe(second.sessionId);
    const count = (getDb().prepare('SELECT COUNT(*) AS n FROM sessions').get() as { n: number }).n;
    expect(count).toBe(1);

    rmSync(worktree, { recursive: true, force: true });
  });

  it('serializes concurrent imports: one wins, the other gets in-progress', async () => {
    const design = seedDesign();
    const designFull = { ...design, linkedProjects: [lookup('p1')!] };
    const worktree = mkdtempSync(path.join(tmpdir(), 'design-import-exec-'));
    const msgs = getStmts().listDesignMessages.all(design.id) as DesignMessageRow[];

    // Both calls start from the same observed (null) imported_session_id. The
    // loser must NOT return a half-built session — it gets an in-progress error.
    const [a, b] = await Promise.allSettled([
      importDesignToSession(buildDeps(worktree), designFull, msgs),
      importDesignToSession(buildDeps(worktree), designFull, msgs),
    ]);

    const fulfilled = [a, b].filter((r) => r.status === 'fulfilled');
    const rejected = [a, b].filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(
      DesignImportInProgressError,
    );

    // Exactly one session was created and the transcript replayed exactly once.
    const winner = (fulfilled[0] as PromiseFulfilledResult<DesignImportResult>).value;
    expect(winner.skipped).toBeUndefined();
    const count = (getDb().prepare('SELECT COUNT(*) AS n FROM sessions').get() as { n: number }).n;
    expect(count).toBe(1);
    const msgCount = (
      getDb()
        .prepare('SELECT COUNT(*) AS n FROM messages WHERE session_id = ?')
        .get(winner.sessionId) as { n: number }
    ).n;
    expect(msgCount).toBe(2);

    // The completed import is published; the lock is released.
    const finalDesign = getStmts().getDesign.get(design.id) as {
      imported_session_id: string | null;
      import_lock: string | null;
    };
    expect(finalDesign.imported_session_id).toBe(winner.sessionId);
    expect(finalDesign.import_lock).toBeNull();

    rmSync(worktree, { recursive: true, force: true });
  });

  it('cleans up the partial session and releases the lock when provisioning fails', async () => {
    const design = seedDesign();
    const designFull = { ...design, linkedProjects: [lookup('p1')!] };
    const worktree = mkdtempSync(path.join(tmpdir(), 'design-import-exec-'));
    const failingDeps = {
      ...buildDeps(worktree),
      provisionSessionWorkspace: vi.fn(async () => {
        throw new Error('worktree boom');
      }),
    };
    const msgs = getStmts().listDesignMessages.all(design.id) as DesignMessageRow[];

    await expect(importDesignToSession(failingDeps, designFull, msgs)).rejects.toThrow(
      'worktree boom',
    );

    // No orphan session, no replayed messages, and the lock was released without
    // ever publishing imported_session_id.
    const count = (getDb().prepare('SELECT COUNT(*) AS n FROM sessions').get() as { n: number }).n;
    expect(count).toBe(0);
    const msgCount = (getDb().prepare('SELECT COUNT(*) AS n FROM messages').get() as { n: number })
      .n;
    expect(msgCount).toBe(0);
    const afterFail = getStmts().getDesign.get(design.id) as {
      imported_session_id: string | null;
      import_lock: string | null;
    };
    expect(afterFail.imported_session_id).toBeNull();
    expect(afterFail.import_lock).toBeNull();

    // A retry with a working provisioner now succeeds cleanly.
    const retry = await importDesignToSession(buildDeps(worktree), designFull, msgs);
    expect(retry.skipped).toBeUndefined();
    expect(retry.importedMessages).toBe(2);
    const finalCount = (
      getDb().prepare('SELECT COUNT(*) AS n FROM sessions').get() as { n: number }
    ).n;
    expect(finalCount).toBe(1);

    rmSync(worktree, { recursive: true, force: true });
  });

  it('detects lost ownership at commit and returns the reclaimer’s completed session', async () => {
    const design = seedDesign();
    const designFull = { ...design, linkedProjects: [lookup('p1')!] };
    const worktree = mkdtempSync(path.join(tmpdir(), 'design-import-exec-'));
    const msgs = getStmts().listDesignMessages.all(design.id) as DesignMessageRow[];
    const winnerSid = 'winner-session-xyz';

    // While our import is provisioning, simulate another importer reclaiming the
    // stale lock and fully completing the design.
    const deps = {
      ...buildDeps(worktree),
      provisionSessionWorkspace: vi.fn(async () => {
        getStmts().createSession.run(
          winnerSid,
          'agent-1',
          '[Design] My Site',
          'claude-code',
          'sonnet',
          1,
          0,
          1,
        );
        getStmts().updateSessionMode.run('design', winnerSid);
        getDb()
          .prepare(
            'UPDATE designs SET imported_session_id = ?, import_lock = NULL, import_locked_at = NULL WHERE id = ?',
          )
          .run(winnerSid, design.id);
        return worktree;
      }),
    };

    const result = await importDesignToSession(deps, designFull, msgs);

    // We must hand back the reclaimer's session, not our orphan.
    expect(result.sessionId).toBe(winnerSid);
    expect(result.skipped).toBe('already-imported');

    // Our orphan session (and its replayed messages) were cleaned up; only the
    // winner survives, and the design points at it.
    const sessionIds = (
      getDb().prepare('SELECT id FROM sessions').all() as Array<{ id: string }>
    ).map((r) => r.id);
    expect(sessionIds).toEqual([winnerSid]);
    const finalDesign = getStmts().getDesign.get(design.id) as {
      imported_session_id: string | null;
      import_lock: string | null;
    };
    expect(finalDesign.imported_session_id).toBe(winnerSid);
    expect(finalDesign.import_lock).toBeNull();

    rmSync(worktree, { recursive: true, force: true });
  });

  it('throws in-progress when ownership is lost but the reclaimer has not committed', async () => {
    const design = seedDesign();
    const designFull = { ...design, linkedProjects: [lookup('p1')!] };
    const worktree = mkdtempSync(path.join(tmpdir(), 'design-import-exec-'));
    const msgs = getStmts().listDesignMessages.all(design.id) as DesignMessageRow[];

    // While provisioning, a competitor reclaims the stale lock but has not yet
    // published imported_session_id.
    const deps = {
      ...buildDeps(worktree),
      provisionSessionWorkspace: vi.fn(async () => {
        getDb()
          .prepare(
            "UPDATE designs SET import_lock = ?, import_locked_at = datetime('now') WHERE id = ?",
          )
          .run('competitor-session', design.id);
        return worktree;
      }),
    };

    await expect(importDesignToSession(deps, designFull, msgs)).rejects.toBeInstanceOf(
      DesignImportInProgressError,
    );

    // Our orphan session was cleaned up; the competitor's lock is untouched.
    const count = (getDb().prepare('SELECT COUNT(*) AS n FROM sessions').get() as { n: number }).n;
    expect(count).toBe(0);
    const finalDesign = getStmts().getDesign.get(design.id) as {
      imported_session_id: string | null;
      import_lock: string | null;
    };
    expect(finalDesign.imported_session_id).toBeNull();
    expect(finalDesign.import_lock).toBe('competitor-session');

    rmSync(worktree, { recursive: true, force: true });
  });
});
