import { describe, it, expect } from 'vitest';
import {
  parseLabels,
  agentClaimsLabel,
  pickAgentForCard,
  pickLead,
  pickMainDevAgent,
} from './routing.js';
import type { Agent, KanbanCardRow, Project } from './types.js';

function makeAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: 'dev-1',
    name: 'Dev',
    engine: 'claude-code',
    role: 'sub',
    ...overrides,
  } as Agent;
}

function makeCard(labels: string | null): Pick<KanbanCardRow, 'labels'> {
  return { labels } as Pick<KanbanCardRow, 'labels'>;
}

describe('parseLabels', () => {
  it('splits a comma-separated string and lowercases each entry', () => {
    expect(parseLabels('Frontend, Backend ,UI')).toEqual(['frontend', 'backend', 'ui']);
  });

  it('returns empty array for null/undefined/non-string input', () => {
    expect(parseLabels(null)).toEqual([]);
    expect(parseLabels(undefined)).toEqual([]);
    expect(parseLabels(42 as unknown as string)).toEqual([]);
  });

  it('drops empty entries from messy input', () => {
    expect(parseLabels(' , , frontend, ')).toEqual(['frontend']);
  });
});

describe('pickMainDevAgent', () => {
  const project = (agents: Agent[]): Project =>
    ({ id: 'p', name: 'Project', cwd: '/tmp', ahw: '/tmp/ahw', agents }) as Project;

  it('prefers the active project lead, then the default dev agent', () => {
    const dev = makeAgent({ id: 'dev', role: 'dev' });
    const lead = makeAgent({ id: 'lead', role: 'lead' });
    expect(pickMainDevAgent(project([dev, lead]))).toBe(lead);
    expect(pickMainDevAgent(project([dev]))).toBe(dev);
  });

  it('skips inactive and helper agents', () => {
    const helper = makeAgent({ id: 'docs', role: 'docs' });
    const inactive = makeAgent({ id: 'inactive', role: 'dev', active: false });
    const fallback = makeAgent({ id: 'fallback', role: 'specialist' });
    expect(pickMainDevAgent(project([helper, inactive, fallback]))).toBe(fallback);
  });
});

describe('agentClaimsLabel', () => {
  it('matches on agent id', () => {
    expect(agentClaimsLabel(makeAgent({ id: 'hub-frontend' }), 'hub-frontend')).toBe(true);
  });

  it('matches on agent role', () => {
    expect(agentClaimsLabel(makeAgent({ role: 'frontend' }), 'frontend')).toBe(true);
  });

  it('matches on agent name (case-insensitive)', () => {
    expect(agentClaimsLabel(makeAgent({ name: 'Hub Backend' }), 'hub backend')).toBe(true);
  });

  it('matches on the tail of a hyphenated id (hub-frontend → frontend)', () => {
    expect(agentClaimsLabel(makeAgent({ id: 'hub-frontend' }), 'frontend')).toBe(true);
    expect(agentClaimsLabel(makeAgent({ id: 'agent-hub-backend' }), 'hub-backend')).toBe(true);
  });

  it('matches ANY trailing suffix of a 3-segment id (agent-hub-mobile → mobile)', () => {
    // Regression: the old single-strip logic produced a tail of `hub-mobile`
    // for `agent-hub-mobile` and so never matched the bare specialty label
    // `mobile`, so "mobile parity" cards were never routed to the mobile
    // specialist and appeared to never get picked up.
    expect(agentClaimsLabel(makeAgent({ id: 'agent-hub-mobile' }), 'mobile')).toBe(true);
    expect(agentClaimsLabel(makeAgent({ id: 'agent-hub-mobile' }), 'hub-mobile')).toBe(true);
    expect(agentClaimsLabel(makeAgent({ id: 'agent-hub-backend' }), 'backend')).toBe(true);
  });

  it('does not match a non-suffix interior or leading segment', () => {
    // `hub` is a leading/interior qualifier of `agent-hub-mobile`, not a
    // trailing suffix — it must not claim the card.
    expect(agentClaimsLabel(makeAgent({ id: 'agent-hub-mobile' }), 'hub')).toBe(false);
    expect(agentClaimsLabel(makeAgent({ id: 'agent-hub-mobile' }), 'agent')).toBe(false);
    expect(agentClaimsLabel(makeAgent({ id: 'agent-hub-mobile' }), 'agent-hub')).toBe(false);
  });

  it('does not match unrelated labels', () => {
    expect(agentClaimsLabel(makeAgent({ id: 'hub-frontend' }), 'mobile')).toBe(false);
  });

  it('returns false for empty/whitespace labels', () => {
    expect(agentClaimsLabel(makeAgent(), '')).toBe(false);
    expect(agentClaimsLabel(makeAgent(), '   ')).toBe(false);
  });
});

describe('pickAgentForCard', () => {
  const fe = makeAgent({ id: 'hub-frontend', role: 'sub', name: 'Frontend' });
  const be = makeAgent({ id: 'hub-backend', role: 'sub', name: 'Backend' });
  const lead = makeAgent({ id: 'hub-lead', role: 'lead', name: 'Lead' });

  function ctxWith(slots: Record<string, number>) {
    return { slotsByAgentId: new Map(Object.entries(slots)) };
  }

  it('routes to the specialist whose id-tail matches a card label', () => {
    const picked = pickAgentForCard({
      card: makeCard('frontend'),
      assignableAgents: [fe, be],
      lead,
      ctx: ctxWith({ 'hub-frontend': 1, 'hub-backend': 1, 'hub-lead': 1 }),
    });
    expect(picked?.id).toBe('hub-frontend');
  });

  it('routes to the specialist whose full id matches a card label', () => {
    const picked = pickAgentForCard({
      card: makeCard('hub-backend'),
      assignableAgents: [fe, be],
      lead,
      ctx: ctxWith({ 'hub-frontend': 1, 'hub-backend': 1, 'hub-lead': 1 }),
    });
    expect(picked?.id).toBe('hub-backend');
  });

  it('routes a bare-specialty label to a 3-segment specialist instead of the lead', () => {
    // Regression for "the mobile parity ticket is not getting picked up":
    // with the `agent-hub-<specialty>` convention, a `mobile`-labelled card
    // must reach `agent-hub-mobile`, not silently fall through to the lead.
    const mobile = makeAgent({ id: 'agent-hub-mobile', role: 'sub', name: 'Mobile' });
    const picked = pickAgentForCard({
      card: makeCard('mobile'),
      assignableAgents: [fe, be, mobile],
      lead,
      ctx: ctxWith({
        'hub-frontend': 1,
        'hub-backend': 1,
        'agent-hub-mobile': 1,
        'hub-lead': 1,
      }),
    });
    expect(picked?.id).toBe('agent-hub-mobile');
  });

  it('honors label order (first matching label wins) when multiple labels are stamped', () => {
    const picked = pickAgentForCard({
      card: makeCard('backend, frontend'),
      assignableAgents: [fe, be],
      lead,
      ctx: ctxWith({ 'hub-frontend': 1, 'hub-backend': 1, 'hub-lead': 1 }),
    });
    expect(picked?.id).toBe('hub-backend');
  });

  it('falls back to the lead when no label matches a specialist', () => {
    const picked = pickAgentForCard({
      card: makeCard('mobile'),
      assignableAgents: [fe, be],
      lead,
      ctx: ctxWith({ 'hub-frontend': 1, 'hub-backend': 1, 'hub-lead': 1 }),
    });
    expect(picked?.id).toBe('hub-lead');
  });

  it('falls back to the lead when the card has no labels at all', () => {
    const picked = pickAgentForCard({
      card: makeCard(null),
      assignableAgents: [fe, be],
      lead,
      ctx: ctxWith({ 'hub-frontend': 1, 'hub-backend': 1, 'hub-lead': 1 }),
    });
    expect(picked?.id).toBe('hub-lead');
  });

  it('skips a matching specialist that has no slots and falls through to the lead', () => {
    const picked = pickAgentForCard({
      card: makeCard('frontend'),
      assignableAgents: [fe, be],
      lead,
      ctx: ctxWith({ 'hub-frontend': 0, 'hub-backend': 1, 'hub-lead': 1 }),
    });
    expect(picked?.id).toBe('hub-lead');
  });

  it('returns null when neither a specialist nor the lead has capacity', () => {
    const picked = pickAgentForCard({
      card: makeCard('frontend'),
      assignableAgents: [fe, be],
      lead,
      ctx: ctxWith({ 'hub-frontend': 0, 'hub-backend': 0, 'hub-lead': 0 }),
    });
    expect(picked).toBeNull();
  });

  it('lead-less project: falls back to first specialist with capacity when no label matches', () => {
    const picked = pickAgentForCard({
      card: makeCard('mobile'),
      assignableAgents: [fe, be],
      lead: null,
      ctx: ctxWith({ 'hub-frontend': 1, 'hub-backend': 1 }),
    });
    // No lead, label "mobile" matches nothing — preserve historical behavior
    // by routing to the first specialist with capacity.
    expect(picked?.id).toBe('hub-frontend');
  });

  it('lead-less project: skips specialists with no capacity in the fallback', () => {
    const picked = pickAgentForCard({
      card: makeCard('mobile'),
      assignableAgents: [fe, be],
      lead: null,
      ctx: ctxWith({ 'hub-frontend': 0, 'hub-backend': 1 }),
    });
    expect(picked?.id).toBe('hub-backend');
  });

  it('lead-less project: returns null when no specialist has capacity', () => {
    const picked = pickAgentForCard({
      card: makeCard('mobile'),
      assignableAgents: [fe, be],
      lead: null,
      ctx: ctxWith({ 'hub-frontend': 0, 'hub-backend': 0 }),
    });
    expect(picked).toBeNull();
  });
});

describe('pickLead', () => {
  it('returns the project agent with role:lead', () => {
    const project = {
      agents: [
        { id: 'a', name: 'A', engine: 'x', role: 'sub' },
        { id: 'b', name: 'B', engine: 'x', role: 'lead' },
      ],
    } as Project;
    expect(pickLead(project)?.id).toBe('b');
  });

  it('returns null when no lead exists', () => {
    const project = {
      agents: [{ id: 'a', name: 'A', engine: 'x', role: 'sub' }],
    } as Project;
    expect(pickLead(project)).toBeNull();
  });

  it('tolerates a project with no agents array', () => {
    expect(pickLead({} as Project)).toBeNull();
  });
});
