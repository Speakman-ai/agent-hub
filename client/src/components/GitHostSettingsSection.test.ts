import { describe, it, expect } from 'vitest';
import { autoResolveAgentOptions } from './GitHostSettingsSection';

describe('autoResolveAgentOptions', () => {
  it('lists every project agent except the Reviewer', () => {
    const project = {
      agents: [
        { id: 'dev', name: 'Dev', role: 'dev' },
        { id: 'rev', name: 'Reviewer', role: 'reviewer' },
        { id: 'docs', role: 'docs' },
      ],
    };
    expect(autoResolveAgentOptions(project)).toEqual([
      { id: 'dev', name: 'Dev' },
      { id: 'docs', name: 'docs' },
    ]);
  });

  it('handles a project with no agents', () => {
    expect(autoResolveAgentOptions({})).toEqual([]);
    expect(autoResolveAgentOptions(null)).toEqual([]);
  });
});
