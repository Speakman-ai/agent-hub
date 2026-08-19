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

  it('affirms browser/web research tools and disavows image generation', () => {
    const withBrowser = buildConsultModePreamble({
      project: { id: 'ops', name: 'Ops', mode: 'workflow' },
      browserToolsEnabled: true,
    });
    expect(withBrowser).toContain('### Research tools stay available');
    expect(withBrowser).toContain('restricts **code ship**, not **investigation**');
    expect(withBrowser).toContain('`browser` ReAct tool');
    expect(withBrowser).toContain('is available in this session');
    expect(withBrowser).toContain('no image-generation tool');
    // Research affirmation sits above the Hard limits so the model reads
    // "you can investigate" before "you cannot ship code".
    expect(withBrowser.indexOf('### Research tools stay available')).toBeLessThan(
      withBrowser.indexOf('### Hard limits'),
    );

    const noBrowser = buildConsultModePreamble({
      project: { id: 'ops', name: 'Ops', mode: 'workflow' },
      browserToolsEnabled: false,
    });
    expect(noBrowser).toContain('Host browser tools are turned **off**');
    expect(noBrowser).not.toContain('is available in this session');
    // web + wiki are still offered even when the browser is off.
    expect(noBrowser).toContain('`web` search and `wiki` retrieval still work');
    expect(noBrowser).toContain('"tool":"preview"');
    expect(noBrowser).toContain('"op":"screenshot"');
    expect(noBrowser).toContain('no image-generation tool');
  });

  it('defaults to affirming the browser when the flag is omitted (back-compat)', () => {
    const dflt = buildConsultModePreamble({ project: { id: 'app', name: 'App', mode: 'dev' } });
    expect(dflt).toContain('is available in this session');
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
