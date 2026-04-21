import { describe, it, expect } from 'vitest';
import config from './config.js';
import { validateKanbanAssignModel } from './kanban-assign-model.js';
import type { Project } from './types.js';

describe('validateKanbanAssignModel', () => {
  const project: Project = {
    id: 'p1',
    name: 'P',
    cwd: '/tmp',
    ahw: '/tmp',
    color: '#000',
    agents: [
      {
        id: 'a1',
        name: 'Dev',
        color: '#fff',
        cwd: '/tmp',
        engine: 'claude-code',
        model: 'claude-opus-4-7',
        role: 'developer',
      },
    ],
  };

  it('accepts a model allowed for the assignee engine', () => {
    const r = validateKanbanAssignModel('claude-sonnet-4-6', project, 'Dev', config);
    expect(r).toEqual({ ok: true });
  });

  it('rejects a model not allowed for the assignee engine', () => {
    const r = validateKanbanAssignModel('gpt-5.3-codex', project, 'Dev', config);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('not valid for engine');
  });

  it('when assignee does not resolve to an agent, requires global allowlist', () => {
    const r = validateKanbanAssignModel('claude-sonnet-4-6', project, 'Nobody', config);
    expect(r).toEqual({ ok: true });
    const bad = validateKanbanAssignModel('totally-fake-model', project, 'Nobody', config);
    expect(bad.ok).toBe(false);
  });
});
