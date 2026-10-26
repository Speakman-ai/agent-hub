import { describe, expect, it } from 'vitest';
import {
  buildQaAuthoringSeed,
  findProjectQaAgent,
  MAX_LINKED_DESCRIPTION_CHARS,
} from './qa-authoring.js';
import type { Agent } from './types.js';

const project = { id: 'proj', name: 'Proj' };
const plan = {
  id: 'plan-1',
  title: 'Checkout',
  goal: 'A signed-in user can buy a thing',
  target_url: 'https://staging.example.com',
};

describe('buildQaAuthoringSeed', () => {
  it('carries the plan id, target, goal, and the linked epic and card descriptions', () => {
    const seed = buildQaAuthoringSeed({
      project,
      plan,
      context: {
        epic: { id: 'epic-1', name: 'Payments', description: 'Epic scope: card payments' },
        card: {
          id: 'card-1',
          shortId: 42,
          title: 'Pay with saved card',
          description: '**Acceptance criteria**\n- [ ] Saved card is preselected',
        },
      },
    });
    expect(seed.startsWith('[QA plan] Checkout')).toBe(true);
    expect(seed).toContain('`plan-1`');
    expect(seed).toContain('`proj`');
    expect(seed).toContain('**Target URL:** https://staging.example.com');
    expect(seed).toContain('**Goal:** A signed-in user can buy a thing');
    expect(seed).toContain('### Linked epic: Payments (`epic-1`)');
    expect(seed).toContain('Epic scope: card payments');
    expect(seed).toContain('### Linked card #42: Pay with saved card (`card-1`)');
    expect(seed).toContain('- [ ] Saved card is preselected');
    expect(seed).toContain('qa.sh case add plan-1');
    expect(seed).toContain('and the acceptance criteria above');
    expect(seed).toMatch(/Do not start a run/);
  });

  it('omits link sections without links and asks for a goal when none was given', () => {
    const seed = buildQaAuthoringSeed({
      project,
      plan: { ...plan, goal: '  ' },
      context: { epic: null, card: null },
    });
    expect(seed).not.toContain('Linked epic');
    expect(seed).not.toContain('Linked card');
    expect(seed).not.toContain('acceptance criteria above');
    expect(seed).toContain('Ask me what this plan should prove');
  });

  it('marks missing descriptions and truncates very long ones', () => {
    const seed = buildQaAuthoringSeed({
      project,
      plan,
      context: {
        epic: { id: 'e', name: 'E', description: null },
        card: {
          id: 'c',
          shortId: null,
          title: 'C',
          description: 'x'.repeat(MAX_LINKED_DESCRIPTION_CHARS + 50),
        },
      },
    });
    expect(seed).toContain('_No description._');
    expect(seed).toContain('### Linked card c: C');
    expect(seed).toContain('[truncated]');
    expect(seed).not.toContain('x'.repeat(MAX_LINKED_DESCRIPTION_CHARS + 1));
  });
});

describe('findProjectQaAgent', () => {
  it('finds the qa-role agent and returns null when there is none', () => {
    const dev = { id: 'dev', name: 'Dev', role: 'dev' } as Agent;
    const qa = { id: 'proj-qa', name: 'QA', role: 'qa' } as Agent;
    expect(findProjectQaAgent({ agents: [dev, qa] })).toBe(qa);
    expect(findProjectQaAgent({ agents: [dev] })).toBeNull();
  });
});
