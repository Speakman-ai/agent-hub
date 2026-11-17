import { describe, it, expect } from 'vitest';
import {
  AGENT_PLAN_MAX_CHARS,
  extractAgentPlanBlocks,
  parseAgentPlanMetadata,
} from './agentPlan.js';
import { stripAssistantControlBlocks } from './stripAssistantControlBlocks.js';
import { deriveSessionTimelineMarkers } from './sessionTimeline.js';

describe('extractAgentPlanBlocks', () => {
  it('returns completed blocks in order and ignores an unclosed one', () => {
    const text =
      'Looking around.\n<agenthub:plan>\n- edit a.ts\n</agenthub:plan>\nworking\n' +
      '<agenthub:plan>second</plan>\n<agenthub:plan>still streaming';
    expect(extractAgentPlanBlocks(text)).toEqual(['- edit a.ts', 'second']);
  });

  it('skips empty blocks and caps long ones', () => {
    expect(extractAgentPlanBlocks('<agenthub:plan>  </agenthub:plan>')).toEqual([]);
    const [long] = extractAgentPlanBlocks(
      `<agenthub:plan>${'x'.repeat(AGENT_PLAN_MAX_CHARS + 50)}</agenthub:plan>`,
    );
    expect(long).toHaveLength(AGENT_PLAN_MAX_CHARS);
  });
});

describe('agent plan rendering contract', () => {
  it('strips the block from the assistant reply', () => {
    expect(
      stripAssistantControlBlocks('Starting.\n<agenthub:plan>\n- do it\n</agenthub:plan>\nDone.'),
    ).toBe('Starting.\n\nDone.');
  });

  it('parses metadata and yields a plan timeline marker', () => {
    const metadata = JSON.stringify({ kind: 'agent_plan', plan: '- edit a.ts' });
    expect(parseAgentPlanMetadata(metadata)).toEqual({ plan: '- edit a.ts' });
    expect(parseAgentPlanMetadata(JSON.stringify({ kind: 'agent_plan', plan: '' }))).toBeNull();
    const markers = deriveSessionTimelineMarkers({
      messages: [{ id: 'm1', role: 'system', metadata, created_at: '2026-11-17 10:00:00' }],
    });
    expect(markers).toEqual([
      expect.objectContaining({ kind: 'plan', anchorId: 'plan:m1', title: '- edit a.ts' }),
    ]);
  });
});
