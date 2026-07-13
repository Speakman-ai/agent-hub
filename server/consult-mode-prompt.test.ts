import { describe, it, expect } from 'vitest';
import { buildConsultModePreamble, requiredConsultSkillIds } from './consult-mode-prompt.js';

describe('consult-mode-prompt', () => {
  it('explains Hub-only scope and no code ship', () => {
    const workflow = buildConsultModePreamble({
      project: { id: 'ops', name: 'Ops', mode: 'workflow' },
    });
    expect(workflow).toContain('Consult mode');
    expect(workflow).toContain('workflow');
    expect(workflow).toContain('no Finalize');

    const dev = buildConsultModePreamble({ project: { id: 'app', name: 'App', mode: 'dev' } });
    expect(dev).toContain('Switch to a **Build** mode');

    const legacyDev = buildConsultModePreamble({ project: { id: 'legacy', name: 'Legacy' } });
    expect(legacyDev).toContain('Switch to a **Build** mode');
  });

  it('requires unresolved spec questions to be asked up front with the picker', () => {
    const prompt = buildConsultModePreamble({
      project: { id: 'ops', name: 'Ops', mode: 'workflow' },
    });

    expect(prompt).toContain('### Spec questions up front');
    expect(prompt).toMatch(/top of your first substantive reply/i);
    expect(prompt).toContain('fenced `agenthub:ask` picker');
    expect(prompt).toContain('Defer this question');
    expect(prompt.indexOf('### Spec questions up front')).toBeLessThan(
      prompt.indexOf('### Hard limits'),
    );
  });

  it('loads Hub skills for consult and legacy ask_mode rows', () => {
    expect(requiredConsultSkillIds({ session_mode: 'consult' })).toEqual([
      'agent-hub',
      'agent-hub-kanban',
    ]);
    expect(requiredConsultSkillIds({ session_mode: 'chat', ask_mode: 1 })).toEqual([
      'agent-hub',
      'agent-hub-kanban',
    ]);
    expect(requiredConsultSkillIds({ session_mode: 'chat' })).toEqual([]);
  });
});
