import { describe, it, expect, vi } from 'vitest';

// Mock the prepared-statement provider so we can force a DB-layer failure.
vi.mock('./db.js', () => ({ getStmts: vi.fn() }));

const { getStmts } = await import('./db.js');
const { listProjectDefaultSkillIds } = await import('./project-default-skills-store.js');

describe('listProjectDefaultSkillIds — error propagation', () => {
  it('propagates a DB failure instead of masking it as an empty list', () => {
    // A closed DB / unavailable statement / query error must NOT be swallowed
    // into `[]` — that would silently disable every project default skill while
    // the REST endpoint reports a successful empty config.
    (getStmts as any).mockReturnValue({
      getProjectDefaultSkills: {
        all: () => {
          throw new Error('database connection is not open');
        },
      },
    });
    expect(() => listProjectDefaultSkillIds('proj-a')).toThrow(/database connection is not open/);
  });

  it('returns the mapped ids on success', () => {
    (getStmts as any).mockReturnValue({
      getProjectDefaultSkills: {
        all: () => [{ skill_id: 'deploy' }, { skill_id: 'survey-tracker' }],
      },
    });
    expect(listProjectDefaultSkillIds('proj-a')).toEqual(['deploy', 'survey-tracker']);
  });
});
