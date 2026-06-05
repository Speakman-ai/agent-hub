import { describe, expect, it, vi } from 'vitest';
import {
  resolveApplyTarget,
  createAndProvisionCommitTarget,
} from './finalize-setup-apply-target.js';
import type { Project, SessionRow } from '../types.js';
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { execFileSync } from 'child_process';

function makeProject(cwd: string): Project {
  return {
    id: 'surveytracker',
    name: 'Survey Tracker',
    cwd,
    color: '#000',
    agents: [{ id: 'agent-1', name: 'Dev', engine: 'claude-code' }],
  } as Project;
}

function seedGitRepo(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'finalize-resolve-'));
  execFileSync('git', ['init', '--initial-branch=main'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 't@example.com'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 't'], { cwd: dir });
  writeFileSync(path.join(dir, 'README.md'), 'x\n');
  execFileSync('git', ['add', '.'], { cwd: dir });
  execFileSync('git', ['commit', '-m', 'seed'], { cwd: dir });
  execFileSync('git', ['checkout', '-b', 'chore/ci'], { cwd: dir });
  return dir;
}

describe('resolveApplyTarget', () => {
  it('binds primary checkout when explicit session has no worktree_path', async () => {
    const repoDir = seedGitRepo();
    const session: SessionRow = {
      id: 'sess-1',
      agent_id: 'agent-1',
      name: 'Card',
      engine: 'claude-code',
      model: 'm',
      use_worktree: 1,
      ask_mode: 0,
      worktree_path: null,
      worktree_branch: null,
    } as SessionRow;
    const updateSessionWorktreePath = { run: vi.fn() };
    const target = await resolveApplyTarget(
      {
        stmts: {
          getSession: { get: vi.fn(() => session) },
          getSessions: { all: vi.fn(() => []) },
          updateSessionWorktreePath,
        } as never,
      },
      makeProject(repoDir),
      'sess-1',
    );
    expect(target).toEqual({
      id: 'sess-1',
      worktree_path: repoDir,
      worktree_branch: 'chore/ci',
    });
    expect(updateSessionWorktreePath.run).toHaveBeenCalledWith(repoDir, 'chore/ci', 'sess-1');
  });
});

describe('createAndProvisionCommitTarget', () => {
  it('creates a use_worktree=1 session, provisions it, and returns the target', async () => {
    const store = new Map<string, SessionRow>();
    const createSession = vi.fn((...args: unknown[]) => {
      const [id, agentId, name, engine, model] = args as [string, string, string, string, string];
      store.set(id, {
        id,
        agent_id: agentId,
        name,
        engine,
        model,
        use_worktree: 1,
        ask_mode: 0,
        worktree_path: null,
        worktree_branch: null,
      } as SessionRow);
    });
    const softDeleteSession = { run: vi.fn() };
    // Simulate ensureWorktree persisting the clone path/branch.
    const provisionSessionWorkspace = vi.fn(async (sid: string) => {
      const row = store.get(sid)!;
      row.worktree_path = '/ws/clone';
      row.worktree_branch = 'agent-hub/agent-1/session-x';
      return '/ws/clone';
    });
    const onCreate = vi.fn();

    const target = await createAndProvisionCommitTarget(
      {
        stmts: {
          getSession: { get: (id: string) => store.get(id) },
          createSession: { run: createSession },
          softDeleteSession,
        } as never,
        provisionSessionWorkspace,
      },
      { agentId: 'agent-1', name: '[Finalize Config] Demo', engine: 'claude-code', model: 'm' },
      onCreate,
    );

    expect(createSession).toHaveBeenCalledTimes(1);
    // use_worktree flag (6th positional arg) must be 1.
    expect(createSession.mock.calls[0][5]).toBe(1);
    expect(provisionSessionWorkspace).toHaveBeenCalledTimes(1);
    expect(onCreate).toHaveBeenCalledTimes(1);
    expect(softDeleteSession.run).not.toHaveBeenCalled();
    expect(target).toEqual({
      id: expect.any(String),
      worktree_path: '/ws/clone',
      worktree_branch: 'agent-hub/agent-1/session-x',
    });
  });

  it('soft-deletes the orphan session and returns null when provisioning fails', async () => {
    const store = new Map<string, SessionRow>();
    const createSession = vi.fn((id: string) => {
      store.set(id, { id, worktree_path: null, worktree_branch: null } as SessionRow);
    });
    const softDeleteSession = { run: vi.fn() };
    // Provision leaves worktree_path unset (the swallowed-failure shape).
    const provisionSessionWorkspace = vi.fn(async () => '/project/cwd');

    const target = await createAndProvisionCommitTarget(
      {
        stmts: {
          getSession: { get: (id: string) => store.get(id) },
          createSession: { run: createSession },
          softDeleteSession,
        } as never,
        provisionSessionWorkspace,
      },
      { agentId: 'agent-1', name: '[Finalize Config] Demo', engine: 'claude-code', model: 'm' },
    );

    expect(target).toBeNull();
    expect(softDeleteSession.run).toHaveBeenCalledTimes(1);
  });

  it('returns null without creating a session when provisioning is unavailable', async () => {
    const createSession = vi.fn();
    const softDeleteSession = { run: vi.fn() };
    const target = await createAndProvisionCommitTarget(
      {
        stmts: {
          getSession: { get: vi.fn() },
          createSession: { run: createSession },
          softDeleteSession,
        } as never,
        provisionSessionWorkspace: undefined,
      },
      { agentId: 'agent-1', name: '[Finalize Config] Demo', engine: 'claude-code', model: 'm' },
    );
    expect(target).toBeNull();
    expect(createSession).not.toHaveBeenCalled();
    expect(softDeleteSession.run).not.toHaveBeenCalled();
  });
});
