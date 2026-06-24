import { describe, expect, it } from 'vitest';
import { buildEpicFlowchartMermaid } from '../utils/epicFlowchart';

describe('buildEpicFlowchartMermaid', () => {
  it('renders epic, phases, tickets, and blocker edges', () => {
    const source = buildEpicFlowchartMermaid({
      epic: { id: 'epic-1', name: 'Auth overhaul', color: '#6366F1' },
      phases: [{ id: 'phase-1', name: 'Login flow', autonomous: 1 }],
      cards: [
        {
          id: 'card-1',
          title: 'Add OAuth',
          epic_id: 'epic-1',
          phase_id: 'phase-1',
          column_id: 'col-todo',
          blockers: [],
        },
        {
          id: 'card-2',
          title: 'Wire callback',
          epic_id: 'epic-1',
          phase_id: 'phase-1',
          column_id: 'col-todo',
          blockers: [{ id: 'card-1', title: 'Add OAuth', done: false }],
        },
      ],
      columnNameById: { 'col-todo': 'To Do', 'col-done': 'Done' },
    });

    expect(source).toContain('flowchart TD');
    expect(source).toContain('Auth overhaul');
    expect(source).toContain('Login flow');
    expect(source).toContain('Add OAuth');
    expect(source).toContain('Wire callback');
    expect(source).toMatch(/card_.* --> card_/);
  });
});
