import { describe, expect, it, vi } from 'vitest';
import { execSync } from 'child_process';
import { mkdirSync, rmSync } from 'fs';
import path from 'path';
import os from 'os';
import {
  resolveFinalizeBaseBranch,
  resolveFinalizeBaseBranchForCard,
} from './resolve-base-branch.js';
import type { KanbanCardRow, KanbanEpicRow } from '../types.js';

describe('resolveFinalizeBaseBranch', () => {
  it('prefers card pr_base_branch override', async () => {
    const branch = await resolveFinalizeBaseBranch({
      card: { pr_base_branch: 'release/v2', epic_id: null },
      worktreePath: '/tmp/unused',
    });
    expect(branch).toBe('release/v2');
  });

  it('falls back to epic pr_base_branch when card omits override', async () => {
    const branch = await resolveFinalizeBaseBranch({
      card: { pr_base_branch: null, epic_id: 'epic-1' },
      epic: { pr_base_branch: 'feature/integration' },
      worktreePath: '/tmp/unused',
    });
    expect(branch).toBe('feature/integration');
  });

  it('detects master from git when no override is configured', async () => {
    const tmpRoot = path.join(
      os.tmpdir(),
      `finalize-base-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(tmpRoot, { recursive: true });
    try {
      execSync('git init --initial-branch=master', { cwd: tmpRoot, stdio: 'pipe' });
      execSync('git config user.email "t@example.com"', { cwd: tmpRoot, stdio: 'pipe' });
      execSync('git config user.name "T"', { cwd: tmpRoot, stdio: 'pipe' });
      execSync('git commit --allow-empty -m init', { cwd: tmpRoot, stdio: 'pipe' });

      const branch = await resolveFinalizeBaseBranch({
        card: { pr_base_branch: null, epic_id: null },
        worktreePath: tmpRoot,
      });
      expect(branch).toBe('master');
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });
});

describe('resolveFinalizeBaseBranchForCard', () => {
  it('loads epic via getEpic when card has epic_id', async () => {
    const getEpic = vi.fn(() => ({ pr_base_branch: 'master' }) as KanbanEpicRow);
    const branch = await resolveFinalizeBaseBranchForCard({
      card: { pr_base_branch: null, epic_id: 'epic-1' } as KanbanCardRow,
      worktreePath: '/tmp/unused',
      getEpic,
    });
    expect(getEpic).toHaveBeenCalledWith('epic-1');
    expect(branch).toBe('master');
  });
});
