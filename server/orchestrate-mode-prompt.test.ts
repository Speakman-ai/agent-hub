import { describe, expect, it } from 'vitest';
import { buildOrchestrateModePreamble } from './orchestrate-mode-prompt.js';

describe('buildOrchestrateModePreamble', () => {
  it('tells the parent chat to start work with a forward card and not to ship', () => {
    const out = buildOrchestrateModePreamble({
      project: {
        id: 'agent-hub',
        name: 'Agent Hub',
        mode: 'dev',
        agents: [
          { id: 'docs', name: 'Docs', role: 'docs', engine: 'claude-code' },
          { id: 'dev', name: 'Dev', role: 'dev', engine: 'claude-code' },
          { id: 'writer', name: 'Writer', role: 'sub', engine: 'claude-code', isDev: false },
        ],
      },
      agentId: 'docs',
    });
    expect(out).toContain('Orchestrate');
    expect(out).toContain('```agenthub:forward');
    expect(out).toContain('"agentId": "dev"');
    expect(out).toContain('`dev` — Dev');
    expect(out).not.toContain('`docs`');
    expect(out).not.toContain('`writer`');
    expect(out).toContain('"mode": "manual"');
    expect(out).toContain('Do not run `sessions.sh dispatch`');
    expect(out).toContain('Do not** edit application source');
    expect(out).toContain('marked **Dev**');
  });

  it('offers only consult on a workflow project', () => {
    const out = buildOrchestrateModePreamble({
      project: { id: 'ops', name: 'Ops', mode: 'workflow', agents: [] },
      agentId: 'ops-agent',
    });
    expect(out).toContain('"mode": "consult"');
    expect(out).not.toContain('"mode": "manual"');
  });
});
