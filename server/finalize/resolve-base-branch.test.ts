import { describe, expect, it, vi } from 'vitest';
import { execSync } from 'child_process';
import { mkdirSync, rmSync } from 'fs';
import path from 'path';
import os from 'os';
import {
  resolveFinalizeBaseBranch,
  resolveFinalizeBaseBranchForCard,
  resolveFinalizeGateBase,
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

describe('resolveFinalizeGateBase', () => {
  it('no card → default (legacy repo-default probe path)', () => {
    expect(resolveFinalizeGateBase({ card: null, worktreePath: '/wt' })).toEqual({
      kind: 'default',
    });
  });

  it('no worktree → default', () => {
    expect(
      resolveFinalizeGateBase({
        card: { pr_base_branch: 'feature/x', epic_id: null } as KanbanCardRow,
        worktreePath: null,
      }),
    ).toEqual({ kind: 'default' });
  });

  it('card override → explicit (authoritative base)', () => {
    expect(
      resolveFinalizeGateBase({
        card: { pr_base_branch: 'feature/epic', epic_id: null } as KanbanCardRow,
        worktreePath: '/wt',
      }),
    ).toEqual({ kind: 'explicit', baseBranch: 'feature/epic' });
  });

  it('epic override → explicit', () => {
    const getEpic = vi.fn(() => ({ pr_base_branch: 'feature/from-epic' }) as KanbanEpicRow);
    expect(
      resolveFinalizeGateBase({
        card: { pr_base_branch: null, epic_id: 'epic-1' } as KanbanCardRow,
        worktreePath: '/wt',
        getEpic,
      }),
    ).toEqual({ kind: 'explicit', baseBranch: 'feature/from-epic' });
  });

  it('card with no override → default (its real base IS the repo default)', () => {
    expect(
      resolveFinalizeGateBase({
        card: { pr_base_branch: null, epic_id: null } as KanbanCardRow,
        worktreePath: '/wt',
      }),
    ).toEqual({ kind: 'default' });
  });

  it('malformed override → unresolved (block, never silent default)', () => {
    expect(
      resolveFinalizeGateBase({
        card: { pr_base_branch: 'bad branch; rm -rf', epic_id: null } as KanbanCardRow,
        worktreePath: '/wt',
      }),
    ).toEqual({ kind: 'unresolved' });
  });

  it('card-backed but base resolution throws → unresolved (block)', () => {
    const getEpic = vi.fn(() => {
      throw new Error('epic lookup failed');
    });
    expect(
      resolveFinalizeGateBase({
        card: { pr_base_branch: null, epic_id: 'epic-1' } as KanbanCardRow,
        worktreePath: '/wt',
        getEpic,
      }),
    ).toEqual({ kind: 'unresolved' });
  });
});
