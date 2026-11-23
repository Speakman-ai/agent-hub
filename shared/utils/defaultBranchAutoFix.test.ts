import { describe, expect, it } from 'vitest';
import { defaultBranchFixAgentOptions } from './defaultBranchAutoFix';

describe('defaultBranchFixAgentOptions', () => {
  it('drops inactive, reviewer and QA agents and falls back to the id for a name', () => {
    expect(
      defaultBranchFixAgentOptions({
        agents: [
          { id: 'rev', name: 'Reviewer', role: 'reviewer' },
          { id: 'qa', name: 'QA', role: 'qa' },
          { id: 'dev', name: 'Dev', role: 'dev' },
          { id: 'lead', role: 'lead' },
          { id: 'off', name: 'Retired', role: 'dev', active: false },
          null,
        ],
      }),
    ).toEqual([
      { id: 'dev', name: 'Dev' },
      { id: 'lead', name: 'lead' },
    ]);
    expect(defaultBranchFixAgentOptions(null)).toEqual([]);
  });
});
