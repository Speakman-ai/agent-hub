import { describe, it, expect } from 'vitest';
import {
  buildOrchestrationBudgetsPayload,
  orchestrationFieldsFromProject,
  orchestrationFieldsFromEpicJson,
} from './orchestrationBudgets.js';

describe('buildOrchestrationBudgetsPayload', () => {
  it('returns null when no numeric fields are set', () => {
    expect(
      buildOrchestrationBudgetsPayload({
        maxContinuationDepth: '',
        maxReactWallClockMs: '',
        maxReactModelTurns: '',
        maxReactActionsPerTurn: '',
        maxWikiRagCallsPerSession: '',
        maxWebSearchCallsPerSession: '',
      }),
    ).toBeNull();
  });

  it('builds a partial object from filled fields', () => {
    const p = buildOrchestrationBudgetsPayload({
      maxContinuationDepth: '3',
      maxReactWallClockMs: '1000',
      maxReactModelTurns: '',
    });
    expect(p).toEqual({
      maxContinuationDepth: 3,
      maxReactWallClockMs: 1000,
    });
  });
});

describe('orchestrationFieldsFromProject', () => {
  it('maps saved project keys to string inputs', () => {
    const f = orchestrationFieldsFromProject({ maxReactActionsPerTurn: 8 });
    expect(f.maxReactActionsPerTurn).toBe('8');
  });
});

describe('orchestrationFieldsFromEpicJson', () => {
  it('parses JSON into string field map', () => {
    const f = orchestrationFieldsFromEpicJson(
      JSON.stringify({ maxContinuationDepth: 5, maxReactModelTurns: 8 }),
    );
    expect(f.maxContinuationDepth).toBe('5');
    expect(f.maxReactModelTurns).toBe('8');
  });

  it('returns empty strings on invalid JSON', () => {
    const f = orchestrationFieldsFromEpicJson('{');
    expect(f.maxContinuationDepth).toBe('');
    expect(f.maxReactWallClockMs).toBe('');
  });
});
