import { describe, it, expect } from 'vitest';
import {
  buildSessionMultiSpawnArgs,
  normalizeSessionMultiEngine,
  isSessionMultiEngine,
} from './session-multi-engine.js';
import { buildMultiAgentTurnPlan, parseMentions } from './session-multi-agent.js';
import type { EnrichedAgent } from './types.js';

describe('normalizeSessionMultiEngine / isSessionMultiEngine', () => {
  it('defaults unknown engines to claude-code', () => {
    expect(normalizeSessionMultiEngine(null)).toBe('claude-code');
    expect(normalizeSessionMultiEngine('')).toBe('claude-code');
    expect(normalizeSessionMultiEngine('gpt-5')).toBe('claude-code');
  });

  it('recognizes supported engines', () => {
    expect(isSessionMultiEngine('cursor-agent')).toBe(true);
    expect(isSessionMultiEngine('gpt-5')).toBe(false);
  });
});

describe('buildSessionMultiSpawnArgs advisory flag', () => {
  const bins = {
    claude: '/bin/claude',
    cursor: '/bin/cursor',
    gemini: '/bin/gemini',
    codex: '/bin/codex',
  };

  it('uses plan permission mode for advisory claude turns', () => {
    const plan = buildSessionMultiSpawnArgs({
      engine: 'claude-code',
      model: 'claude-opus-4-6',
      systemPrompt: 'sys',
      userPrompt: 'user',
      bins,
      advisory: true,
    });
    expect(plan.args).toContain('plan');
    expect(plan.bin).toBe('/bin/claude');
  });

  it('uses bypass for executor claude turns', () => {
    const plan = buildSessionMultiSpawnArgs({
      engine: 'claude-code',
      model: 'claude-opus-4-6',
      systemPrompt: 'sys',
      userPrompt: 'user',
      bins,
      advisory: false,
    });
    expect(plan.args).toContain('bypassPermissions');
  });
});

describe('buildMultiAgentTurnPlan', () => {
  const primary = {
    id: 'a1',
    name: 'Lead',
    color: '#f00',
    projectId: 'p1',
    cwd: '/tmp',
  } as EnrichedAgent;
  const advisor1 = { ...primary, id: 'a2', name: 'Reviewer' } as EnrichedAgent;
  const advisor2 = { ...primary, id: 'a3', name: 'Security' } as EnrichedAgent;

  it('starts with primary then advisor + follow-up pairs', () => {
    const plan = buildMultiAgentTurnPlan(primary, [advisor1], 'hello', 10);
    expect(plan.map((t) => t.kind)).toEqual(['executor_initial', 'advisor', 'executor_followup']);
  });

  it('respects max advisor turns', () => {
    const plan = buildMultiAgentTurnPlan(primary, [advisor1, advisor2], 'hello', 1);
    const advisorTurns = plan.filter((t) => t.kind === 'advisor');
    expect(advisorTurns).toHaveLength(1);
  });

  it('parseMentions filters advisors', () => {
    const mentions = parseMentions('hey @Security check this', [advisor1, advisor2]);
    expect(mentions.has('a3')).toBe(true);
    expect(mentions.has('a2')).toBe(false);
  });

  it('parseMentions prefers longer name when one is a prefix of another', () => {
    const reviewer = { ...primary, id: 'r1', name: 'Reviewer' } as EnrichedAgent;
    const reviewerBot = { ...primary, id: 'r2', name: 'ReviewerBot' } as EnrichedAgent;
    const mentions = parseMentions('@Reviewer please review', [reviewer, reviewerBot]);
    expect(mentions.has('r1')).toBe(true);
    expect(mentions.has('r2')).toBe(false);
  });
});
