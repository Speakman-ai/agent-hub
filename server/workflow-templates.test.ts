import { describe, it, expect } from 'vitest';
import { mergeWorkflowTriggerPayload, substituteWorkflowTemplate } from './workflow-templates.js';

describe('mergeWorkflowTriggerPayload', () => {
  it('merges run over default (shallow)', () => {
    const o = mergeWorkflowTriggerPayload('{"a":1,"b":0}', '{"b":2}');
    expect(o).toEqual({ a: 1, b: 2 });
  });
  it('returns default when run is null', () => {
    const o = mergeWorkflowTriggerPayload('{"x":true}', null);
    expect(o).toEqual({ x: true });
  });
  it('tolerates invalid JSON in default', () => {
    const o = mergeWorkflowTriggerPayload('notjson', null);
    expect(o).toEqual({});
  });
});

describe('substituteWorkflowTemplate', () => {
  const stepOutputs = new Map([['s1', 'out-one']]);
  it('injects full trigger JSON', () => {
    const s = substituteWorkflowTemplate('x={{trigger.payload}} y', {
      triggerPayload: { a: 1 },
      stepOutputs,
    });
    expect(s).toBe('x={"a":1} y');
  });
  it('follows JSON path for trigger', () => {
    const s = substituteWorkflowTemplate('v={{trigger.payload.p.q}}', {
      triggerPayload: { p: { q: 9 } },
      stepOutputs,
    });
    expect(s).toBe('v=9');
  });
  it('resolves prior step output', () => {
    const s = substituteWorkflowTemplate('prev={{steps.s1.output}}', {
      triggerPayload: {},
      stepOutputs,
    });
    expect(s).toBe('prev=out-one');
  });
  it('leaves unknown placeholders as-is', () => {
    const t = 'keep {{nope.unknown}}';
    expect(substituteWorkflowTemplate(t, { triggerPayload: {}, stepOutputs: new Map() })).toBe(t);
  });
  it('supports multi-step id with hyphens in {{steps...output}}', () => {
    const id = '8c3a2d1a-0f1e-4b2a-8c0d-abcdef000001';
    const s = substituteWorkflowTemplate(`X={{steps.${id}.output}}`, {
      triggerPayload: {},
      stepOutputs: new Map([[id, 'z']]),
    });
    expect(s).toBe('X=z');
  });
});
