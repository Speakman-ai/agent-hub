import { describe, expect, it } from 'vitest';
import { buildScopingModePreamble } from './scoping-mode-prompt.js';

describe('buildScopingModePreamble', () => {
  const base = { projectName: 'agent-hub', projectId: 'agent-hub' };

  it('mandates at least one phase per epic in the hierarchy contract', () => {
    const out = buildScopingModePreamble(base);
    expect(out).toContain('at least one phase');
  });

  it('rules the agent must never leave an epic with zero phases', () => {
    const out = buildScopingModePreamble(base);
    expect(out).toContain('Never leave an epic with zero phases.');
    expect(out).toMatch(/always create at least one phase/);
  });

  it('still requires every implementation ticket to belong to a phase', () => {
    const out = buildScopingModePreamble(base);
    expect(out).toContain('Every implementation ticket should belong to a phase');
  });
});
