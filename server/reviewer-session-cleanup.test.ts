import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import type { BroadcastFn, Project, SessionRow, Stmts } from './types.js';
import {
  cleanupReviewerSessionForPR,
  findProjectByRepo,
  type ReviewerSessionCleanupDeps,
} from './reviewer-session-cleanup.js';

interface TestDeps {
  db: Database.Database;
  stmts: Pick<Stmts, 'softDeleteSession' | 'getActiveReviewerSessionForPR'>;
}

function makeDb(): TestDeps {
  const db = new Database(':memory:');
  // Minimal sessions table — only the columns the cleanup helper reads.
  db.exec(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      name TEXT,
      worktree_path TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      deleted_at TEXT
    );
  `);
  const stmts = {
    softDeleteSession: db.prepare(
      "UPDATE sessions SET deleted_at = datetime('now'), updated_at = datetime('now') WHERE id = ? AND deleted_at IS NULL",
    ),
    getActiveReviewerSessionForPR: db.prepare(
      `SELECT * FROM sessions
       WHERE agent_id = ?
         AND name LIKE ?
         AND deleted_at IS NULL
       ORDER BY created_at DESC
       LIMIT 1`,
    ),
  };
  return { db, stmts };
}

function seedSession(
  db: Database.Database,
  row: Partial<SessionRow> & { id: string; agent_id: string; name: string },
  createdAtIso?: string,
): void {
  db.prepare(
    "INSERT INTO sessions (id, agent_id, name, worktree_path, created_at, updated_at, deleted_at) VALUES (?, ?, ?, ?, COALESCE(?, datetime('now')), datetime('now'), ?)",
  ).run(
    row.id,
    row.agent_id,
    row.name,
    row.worktree_path ?? null,
    createdAtIso ?? null,
    row.deleted_at ?? null,
  );
}

function projectWithReviewer(id: string, repo: string | null, reviewerId: string | null): Project {
  return {
    id,
    name: id,
    githubRepo: repo ?? undefined,
    agents: reviewerId
      ? [{ id: reviewerId, name: reviewerId, role: 'reviewer', engine: 'claude-code' }]
      : [],
  } as unknown as Project;
}

describe('findProjectByRepo', () => {
  it('matches case-insensitively', () => {
    const projects = [projectWithReviewer('p', 'Speakman-AI/agent-hub', 'r1')];
    expect(findProjectByRepo(projects, 'speakman-ai', 'AGENT-HUB')?.id).toBe('p');
  });

  it('returns null when no project matches', () => {
    const projects = [projectWithReviewer('p', 'me/repo', 'r1')];
    expect(findProjectByRepo(projects, 'someone', 'else')).toBeNull();
  });

  it('skips projects without githubRepo', () => {
    const projects = [
      projectWithReviewer('p1', null, 'r1'),
      projectWithReviewer('p2', 'me/repo', 'r2'),
    ];
    expect(findProjectByRepo(projects, 'me', 'repo')?.id).toBe('p2');
  });
});

describe('cleanupReviewerSessionForPR', () => {
  let deps: TestDeps;
  let removeWorkspace: ReturnType<typeof vi.fn<(workspacePath: string) => boolean>>;
  let broadcastSpy: ReturnType<typeof vi.fn<(data: Record<string, unknown>) => void>>;
  let broadcast: BroadcastFn;
  let activeProcesses: Map<string, { kill: ReturnType<typeof vi.fn> }>;
  const pr = { owner: 'me', repo: 'repo', number: '42' };

  beforeEach(() => {
    deps = makeDb();
    removeWorkspace = vi.fn<(workspacePath: string) => boolean>().mockReturnValue(true);
    broadcastSpy = vi.fn<(data: Record<string, unknown>) => void>();
    broadcast = ((data: Record<string, unknown>) => broadcastSpy(data)) as BroadcastFn;
    activeProcesses = new Map();
  });

  function build(getProjects: () => Project[]): ReviewerSessionCleanupDeps {
    return {
      stmts: deps.stmts,
      broadcast,
      getProjects,
      // The Map<string, ChildProcess> type is satisfied at runtime by our
      // stub objects with a `.kill` method.
      activeProcesses: activeProcesses as unknown as Map<
        string,
        import('child_process').ChildProcess
      >,
      removeWorkspace,
    };
  }

  it('happy path: soft-deletes row, removes worktree, broadcasts', () => {
    seedSession(deps.db, {
      id: 'sess-1',
      agent_id: 'rev-1',
      name: 'Review: PR #42 Add feature',
      worktree_path: '/workspaces/agent-hub/session-sess-1',
    });

    const result = cleanupReviewerSessionForPR(
      pr,
      build(() => [projectWithReviewer('p', 'me/repo', 'rev-1')]),
    );

    expect(result.status).toBe('cleaned');
    expect(result.sessionId).toBe('sess-1');
    expect(result.worktreeRemoved).toBe(true);
    expect(removeWorkspace).toHaveBeenCalledWith('/workspaces/agent-hub/session-sess-1');
    expect(broadcastSpy).toHaveBeenCalledWith({ type: 'session_deleted', sessionId: 'sess-1' });

    const row = deps.db.prepare('SELECT deleted_at FROM sessions WHERE id = ?').get('sess-1') as {
      deleted_at: string | null;
    };
    expect(row.deleted_at).not.toBeNull();
  });

  it('returns no-project when no githubRepo matches', () => {
    seedSession(deps.db, {
      id: 'sess-1',
      agent_id: 'rev-1',
      name: 'Review: PR #42 X',
    });
    const result = cleanupReviewerSessionForPR(
      pr,
      build(() => [projectWithReviewer('p', 'other/repo', 'rev-1')]),
    );
    expect(result.status).toBe('no-project');
    expect(removeWorkspace).not.toHaveBeenCalled();
    expect(broadcastSpy).not.toHaveBeenCalled();
  });

  it('returns no-reviewer when project has no reviewer agent', () => {
    seedSession(deps.db, {
      id: 'sess-1',
      agent_id: 'rev-1',
      name: 'Review: PR #42 X',
    });
    const result = cleanupReviewerSessionForPR(
      pr,
      build(() => [projectWithReviewer('p', 'me/repo', null)]),
    );
    expect(result.status).toBe('no-reviewer');
    expect(removeWorkspace).not.toHaveBeenCalled();
  });

  it('returns no-session when no live session matches', () => {
    // wrong agent + wrong PR number
    seedSession(deps.db, {
      id: 'sess-other',
      agent_id: 'rev-other',
      name: 'Review: PR #99 unrelated',
    });
    const result = cleanupReviewerSessionForPR(
      pr,
      build(() => [projectWithReviewer('p', 'me/repo', 'rev-1')]),
    );
    expect(result.status).toBe('no-session');
  });

  it('skips already-archived sessions', () => {
    seedSession(deps.db, {
      id: 'sess-archived',
      agent_id: 'rev-1',
      name: 'Review: PR #42 X',
      deleted_at: '2026-01-01T00:00:00Z',
    });
    const result = cleanupReviewerSessionForPR(
      pr,
      build(() => [projectWithReviewer('p', 'me/repo', 'rev-1')]),
    );
    expect(result.status).toBe('no-session');
  });

  it('newest session wins on re-review', () => {
    seedSession(
      deps.db,
      { id: 'sess-old', agent_id: 'rev-1', name: 'Review: PR #42 First' },
      '2026-01-01T00:00:00Z',
    );
    seedSession(
      deps.db,
      { id: 'sess-new', agent_id: 'rev-1', name: 'Review: PR #42 Second' },
      '2026-02-01T00:00:00Z',
    );
    const result = cleanupReviewerSessionForPR(
      pr,
      build(() => [projectWithReviewer('p', 'me/repo', 'rev-1')]),
    );
    expect(result.status).toBe('cleaned');
    expect(result.sessionId).toBe('sess-new');

    // Only the newest is archived.
    const oldRow = deps.db
      .prepare('SELECT deleted_at FROM sessions WHERE id = ?')
      .get('sess-old') as { deleted_at: string | null };
    expect(oldRow.deleted_at).toBeNull();
  });

  it('does not match a different PR with the same prefix (#12 vs #123)', () => {
    seedSession(deps.db, {
      id: 'sess-123',
      agent_id: 'rev-1',
      name: 'Review: PR #123 Big',
    });
    const result = cleanupReviewerSessionForPR(
      { owner: 'me', repo: 'repo', number: '12' },
      build(() => [projectWithReviewer('p', 'me/repo', 'rev-1')]),
    );
    expect(result.status).toBe('no-session');
  });

  it('SIGTERMs in-flight CLI process before soft-delete', () => {
    seedSession(deps.db, {
      id: 'sess-1',
      agent_id: 'rev-1',
      name: 'Review: PR #42 X',
    });
    const kill = vi.fn();
    activeProcesses.set('sess-1', { kill });
    const result = cleanupReviewerSessionForPR(
      pr,
      build(() => [projectWithReviewer('p', 'me/repo', 'rev-1')]),
    );
    expect(result.status).toBe('cleaned');
    expect(result.processKilled).toBe(true);
    expect(kill).toHaveBeenCalledWith('SIGTERM');
    expect(activeProcesses.has('sess-1')).toBe(false);
  });

  it('still soft-deletes when SIGTERM throws', () => {
    seedSession(deps.db, {
      id: 'sess-1',
      agent_id: 'rev-1',
      name: 'Review: PR #42 X',
    });
    activeProcesses.set('sess-1', {
      kill: vi.fn().mockImplementation(() => {
        throw new Error('boom');
      }),
    });
    const result = cleanupReviewerSessionForPR(
      pr,
      build(() => [projectWithReviewer('p', 'me/repo', 'rev-1')]),
    );
    expect(result.status).toBe('cleaned');
    const row = deps.db.prepare('SELECT deleted_at FROM sessions WHERE id = ?').get('sess-1') as {
      deleted_at: string | null;
    };
    expect(row.deleted_at).not.toBeNull();
  });

  it('skips removeWorkspace when worktree_path is null', () => {
    seedSession(deps.db, {
      id: 'sess-1',
      agent_id: 'rev-1',
      name: 'Review: PR #42 X',
      worktree_path: null,
    });
    const result = cleanupReviewerSessionForPR(
      pr,
      build(() => [projectWithReviewer('p', 'me/repo', 'rev-1')]),
    );
    expect(result.status).toBe('cleaned');
    expect(result.worktreeRemoved).toBe(false);
    expect(removeWorkspace).not.toHaveBeenCalled();
  });

  it('still broadcasts when removeWorkspace throws', () => {
    seedSession(deps.db, {
      id: 'sess-1',
      agent_id: 'rev-1',
      name: 'Review: PR #42 X',
      worktree_path: '/some/path',
    });
    removeWorkspace.mockImplementation(() => {
      throw new Error('disk full');
    });
    const result = cleanupReviewerSessionForPR(
      pr,
      build(() => [projectWithReviewer('p', 'me/repo', 'rev-1')]),
    );
    expect(result.status).toBe('cleaned');
    expect(broadcastSpy).toHaveBeenCalledWith({ type: 'session_deleted', sessionId: 'sess-1' });
  });
});
