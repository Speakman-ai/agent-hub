import { describe, expect, it, vi } from 'vitest';
import { resolveApplyTarget } from './finalize-setup-apply-target.js';
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
