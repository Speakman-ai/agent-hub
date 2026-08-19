import { describe, it, expect } from 'vitest';
import {
  buildOrchestrationBudgetsPayload,
  DEFAULT_ORCHESTRATION_BUDGETS,
  ORCHESTRATION_FIELD_META,
  orchestrationFieldsFromProject,
  orchestrationFieldsFromEpicJson,
} from './orchestrationBudgets';

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
    expect(p!).toEqual({
      maxContinuationDepth: 3,
      maxReactWallClockMs: 1000,
    });
  });
});

describe('ORCHESTRATION_FIELD_META', () => {
  it('placeholders show the numeric server defaults', () => {
    const byKey = Object.fromEntries(
      ORCHESTRATION_FIELD_META.map((m: { key: string; placeholder: string }) => [
        m.key,
        m.placeholder,
      ]),
    );
    expect(byKey.maxContinuationDepth).toBe(
      `${DEFAULT_ORCHESTRATION_BUDGETS.maxContinuationDepth} default`,
    );
    expect(byKey.maxReactWallClockMs).toBe(
      `${DEFAULT_ORCHESTRATION_BUDGETS.maxReactWallClockMs} unlimited`,
    );
    expect(byKey.maxReactModelTurns).toBe(
      `${DEFAULT_ORCHESTRATION_BUDGETS.maxReactModelTurns} (depth only)`,
    );
    expect(byKey.maxReactActionsPerTurn).toBe(
      `${DEFAULT_ORCHESTRATION_BUDGETS.maxReactActionsPerTurn} default`,
    );
    expect(byKey.maxWikiRagCallsPerSession).toBe(
      `${DEFAULT_ORCHESTRATION_BUDGETS.maxWikiRagCallsPerSession} default`,
    );
    expect(byKey.maxWebSearchCallsPerSession).toBe(
      `${DEFAULT_ORCHESTRATION_BUDGETS.maxWebSearchCallsPerSession} default`,
    );
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
