import { describe, it, expect } from 'vitest';
import { parsePrBaseBranchInput, effectivePrBaseBranch } from './kanban-pr-base.js';
import type { KanbanCardRow, KanbanEpicRow } from './types.js';

describe('parsePrBaseBranchInput', () => {
  it('accepts valid branch segments', () => {
    expect(parsePrBaseBranchInput('feature/foo-bar.v1')).toEqual({
      ok: true,
      value: 'feature/foo-bar.v1',
    });
  });

  it('treats empty as clear', () => {
    expect(parsePrBaseBranchInput('')).toEqual({ ok: true, value: null });
    expect(parsePrBaseBranchInput(null)).toEqual({ ok: true, value: null });
  });

  it('rejects unsafe characters', () => {
    const r = parsePrBaseBranchInput('foo;rm -rf');
    expect(r.ok).toBe(false);
  });
});

describe('effectivePrBaseBranch', () => {
  it('prefers card override over epic default', () => {
    const card = {
      pr_base_branch: 'feature/card',
      epic_id: 'e1',
    } as Pick<KanbanCardRow, 'pr_base_branch' | 'epic_id'>;
    const epic = { pr_base_branch: 'feature/epic' } as Pick<KanbanEpicRow, 'pr_base_branch'>;
    expect(effectivePrBaseBranch(card, epic)).toBe('feature/card');
  });

  it('falls back to epic when card has no override', () => {
    const card = {
      pr_base_branch: null,
      epic_id: 'e1',
    } as Pick<KanbanCardRow, 'pr_base_branch' | 'epic_id'>;
    const epic = { pr_base_branch: 'feature/epic' } as Pick<KanbanEpicRow, 'pr_base_branch'>;
    expect(effectivePrBaseBranch(card, epic)).toBe('feature/epic');
  });

  it('returns null when neither is set', () => {
    const card = { pr_base_branch: null, epic_id: null } as Pick<
      KanbanCardRow,
      'pr_base_branch' | 'epic_id'
    >;
    expect(effectivePrBaseBranch(card, null)).toBeNull();
  });
});
