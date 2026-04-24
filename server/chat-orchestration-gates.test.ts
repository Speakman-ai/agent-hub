/**
 * Tests for orchestration gate branches added in chat.ts:
 *   1. detectCloseCardBlock gate rejection — `present && !task && reason` triggers system message
 *   2. Malformed <delegate> block rejection — parseDelegateBlock returns null for missing contract fields
 *
 * These tests would regress if:
 * - detectCloseCardBlock stopped returning `reason` for malformed blocks (gate rejection never fires)
 * - parseDelegateBlock stopped returning null for tasks missing contract fields (malformed delegate never fires)
 */

import { describe, it, expect } from 'vitest';
import { detectCloseCardBlock, describeCloseCardReason } from './card-auto-close.js';
import { detectDelegateBlock, parseDelegateBlock } from './delegation.js';

// ── Close-card gate rejection ──────────────────────────────────────────────

describe('detectCloseCardBlock — gate rejection signal', () => {
  it('returns present=true, task=null, reason set when JSON is invalid', () => {
    const text = '<agenthub:close-card>not json</agenthub:close-card>';
    const result = detectCloseCardBlock(text);
    expect(result.present).toBe(true);
    expect(result.task).toBeNull();
    expect(result.reason).toBe('invalid-json');
    // This is exactly the condition chat.ts uses to fire the gate-rejection system message:
    // if (closeCardDetection.present && !closeTask && closeCardDetection.reason)
  });

  it('returns present=true, task=null, reason set when "reason" field is missing', () => {
    const text = '<agenthub:close-card>{"note":"test"}</agenthub:close-card>';
    const result = detectCloseCardBlock(text);
    expect(result.present).toBe(true);
    expect(result.task).toBeNull();
    expect(result.reason).toBe('missing-reason');
  });

  it('returns present=true, task=null, reason set when "note" field is missing', () => {
    const text = '<agenthub:close-card>{"reason":"already-done"}</agenthub:close-card>';
    const result = detectCloseCardBlock(text);
    expect(result.present).toBe(true);
    expect(result.task).toBeNull();
    expect(result.reason).toBe('missing-note');
  });

  it('returns present=false, task=null when no block is present', () => {
    const result = detectCloseCardBlock('No close-card block here.');
    expect(result.present).toBe(false);
    expect(result.task).toBeNull();
    expect(result.reason).toBeNull();
  });
});

// ── describeCloseCardReason covers all malformed reason codes ─────────────

describe('describeCloseCardReason', () => {
  const cases: Array<[Parameters<typeof describeCloseCardReason>[0], string]> = [
    ['invalid-json', 'invalid JSON'],
    ['not-object', 'not a JSON object'],
    ['missing-reason', 'missing the "reason" field'],
    ['invalid-reason', 'invalid "reason" value'],
    ['missing-note', 'missing the "note" field'],
    ['empty-note', 'empty'],
  ];

  for (const [reason, fragment] of cases) {
    it(`describes "${reason}" with a human-readable message`, () => {
      const desc = describeCloseCardReason(reason);
      expect(typeof desc).toBe('string');
      expect(desc.length).toBeGreaterThan(0);
      expect(desc.toLowerCase()).toContain(fragment.toLowerCase());
    });
  }
});

// ── Delegate contract validation (missing-contract-fields → gate rejected) ─

describe('parseDelegateBlock — contract field validation', () => {
  const fullTask = {
    agentId: 'sub-agent-1',
    task: 'Implement the feature',
    owner: 'hub-lead',
    scope: 'Server-side only',
    expectedArtifact: 'PR with passing tests',
    deadline: 'end of sprint',
    returnFormat: 'summary + PR URL',
  };

  it('returns a valid task array when all contract fields are present', () => {
    const text = `<delegate>${JSON.stringify([fullTask])}</delegate>`;
    const tasks = parseDelegateBlock(text);
    expect(tasks).not.toBeNull();
    expect(tasks).toHaveLength(1);
    expect(tasks![0].agentId).toBe('sub-agent-1');
  });

  it('returns null (triggers gate rejection) when "owner" is missing', () => {
    const { owner: _owner, ...noOwner } = fullTask;
    const text = `<delegate>${JSON.stringify([noOwner])}</delegate>`;
    // null → chat.ts fires: "Delegation gate rejected." system message
    expect(parseDelegateBlock(text)).toBeNull();
  });

  it('returns null when "scope" is missing', () => {
    const { scope: _scope, ...noScope } = fullTask;
    expect(parseDelegateBlock(`<delegate>${JSON.stringify([noScope])}</delegate>`)).toBeNull();
  });

  it('returns null when "expectedArtifact" is missing', () => {
    const { expectedArtifact: _ea, ...noEA } = fullTask;
    expect(parseDelegateBlock(`<delegate>${JSON.stringify([noEA])}</delegate>`)).toBeNull();
  });

  it('returns null when "deadline" is missing', () => {
    const { deadline: _dl, ...noDL } = fullTask;
    expect(parseDelegateBlock(`<delegate>${JSON.stringify([noDL])}</delegate>`)).toBeNull();
  });

  it('returns null when "returnFormat" is missing', () => {
    const { returnFormat: _rf, ...noRF } = fullTask;
    expect(parseDelegateBlock(`<delegate>${JSON.stringify([noRF])}</delegate>`)).toBeNull();
  });

  it('returns null when a single-object payload omits required contract fields', () => {
    expect(parseDelegateBlock('<delegate>{"agentId":"x","task":"y"}</delegate>')).toBeNull();
  });

  it('parses a single-object payload when every contract field is present', () => {
    const t = { ...fullTask };
    expect(parseDelegateBlock(`<delegate>${JSON.stringify(t)}</delegate>`)).toEqual([t]);
  });

  it('accepts toAgent as an alias for agentId when every contract field is present', () => {
    const { agentId, ...rest } = fullTask;
    const row = { toAgent: agentId, ...rest };
    const parsed = parseDelegateBlock(`<delegate>${JSON.stringify([row])}</delegate>`);
    expect(parsed).not.toBeNull();
    expect(parsed![0].agentId).toBe(fullTask.agentId);
  });

  it('returns null when the payload is an empty array', () => {
    expect(parseDelegateBlock('<delegate>[]</delegate>')).toBeNull();
  });
});

// ── detectDelegateBlock detection result for gate-rejection scenarios ──────

describe('detectDelegateBlock — missing-contract-fields reason', () => {
  it('reports missing-contract-fields when some but not all tasks are valid', () => {
    const fullTask = {
      agentId: 'sub-1',
      task: 'Do something',
      owner: 'lead',
      scope: 'server',
      expectedArtifact: 'PR',
      deadline: 'today',
      returnFormat: 'summary',
    };
    const taskMissingOwner = { agentId: 'sub-2', task: 'Also do something' };
    const text = `<delegate>${JSON.stringify([fullTask, taskMissingOwner])}</delegate>`;
    const detection = detectDelegateBlock(text);
    expect(detection.present).toBe(true);
    expect(detection.tasks).toBeNull();
    expect(detection.reason).toBe('missing-contract-fields');
  });
});
