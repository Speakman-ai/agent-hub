import { describe, expect, it } from 'vitest';
import { buildDecideForMeSessionContext, pickDefaultDecideAgent } from './spec-decide-for-me.js';
import type { KanbanEpicSpecItemRow, Project } from './types.js';

const baseSpec = (over: Partial<KanbanEpicSpecItemRow>): KanbanEpicSpecItemRow => ({
  id: 'spec-1',
  epic_id: 'epic-1',
  board_id: 'board-1',
  phase_id: null,
  tag: 'MODEL',
  title: 'Phase table shape',
  decision: null,
  status: 'open',
  position: 0,
  spike_card_id: null,
  resolved_session_id: null,
  created_at: '',
  updated_at: '',
  ...over,
});

const project = (agents: Project['agents']): Project =>
  ({
    id: 'agent-hub',
    name: 'Agent Hub',
    agents,
  }) as Project;

describe('spec-decide-for-me', () => {
  it('buildDecideForMeSessionContext instructs no code and API lock', () => {
    const ctx = buildDecideForMeSessionContext({
      specItem: baseSpec({ id: 'spec-abc', tag: 'AUTH', title: 'Session auth model' }),
      projectId: 'agent-hub',
      projectName: 'Agent Hub',
    });
    expect(ctx).toContain('Session auth model');
    expect(ctx).toContain('spec-abc');
    expect(ctx).toContain('No code');
    expect(ctx).toContain('## Decision');
    expect(ctx).toContain('## Rationale');
    expect(ctx).toContain('PUT /api/projects/agent-hub/board/spec-items/spec-abc');
    expect(ctx).toContain('Do **not** create kanban tickets');
  });

  it('includes existing draft when present', () => {
    const ctx = buildDecideForMeSessionContext({
      specItem: baseSpec({ decision: 'Leaning toward JWT' }),
      projectId: 'p',
    });
    expect(ctx).toContain('Leaning toward JWT');
  });

  it('pickDefaultDecideAgent prefers lead then dev fallback', () => {
    const lead = pickDefaultDecideAgent(
      project([
        { id: 'reviewer', name: 'Rev', role: 'reviewer' },
        { id: 'lead', name: 'Lead', role: 'lead' },
        { id: 'dev', name: 'Dev', role: 'developer' },
      ] as Project['agents']),
    );
    expect(lead).toEqual({ id: 'lead', name: 'Lead' });

    const dev = pickDefaultDecideAgent(
      project([
        { id: 'reviewer', name: 'Rev', role: 'reviewer' },
        { id: 'dev', name: 'Dev', role: 'developer' },
      ] as Project['agents']),
    );
    expect(dev).toEqual({ id: 'dev', name: 'Dev' });
  });
});
