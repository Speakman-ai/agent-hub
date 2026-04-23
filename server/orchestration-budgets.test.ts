import { describe, it, expect } from 'vitest';
import {
  DEFAULT_ORCHESTRATION_BUDGETS,
  evaluateReactContinuationBudgets,
  finalizeResolvedBudgets,
  mergeOrchestrationBudgets,
  parseEpicOrchestrationBudgetsJson,
  projectOrchestrationDefaults,
  resolveOrchestrationBudgets,
  sanitizeOrchestrationBudgetsPartial,
} from './orchestration-budgets.js';
import type { KanbanEpicRow, Project } from './types.js';

describe('sanitizeOrchestrationBudgetsPartial', () => {
  it('returns null for non-objects', () => {
    expect(sanitizeOrchestrationBudgetsPartial(null)).toBeNull();
    expect(sanitizeOrchestrationBudgetsPartial('x')).toBeNull();
    expect(sanitizeOrchestrationBudgetsPartial([])).toBeNull();
  });

  it('accepts bounded numeric fields', () => {
    expect(
      sanitizeOrchestrationBudgetsPartial({
        maxContinuationDepth: 2,
        maxReactWallClockMs: 5000,
        maxReactActionsPerTurn: 4,
      }),
    ).toEqual({
      maxContinuationDepth: 2,
      maxReactWallClockMs: 5000,
      maxReactActionsPerTurn: 4,
    });
  });
});

describe('merge + resolve', () => {
  it('merges epic JSON over project defaults', () => {
    const project = {
      id: 'p1',
      name: 'P',
      cwd: '/tmp',
      ahw: '/tmp',
      agents: [],
      orchestrationBudgets: { maxContinuationDepth: 3 },
    } as unknown as Project;
    const epic = {
      id: 'e1',
      board_id: 'b',
      name: 'E',
      description: null,
      color: '#fff',
      autonomous: 0,
      autonomous_interval: 0,
      autonomous_max_concurrent: 0,
      autonomous_max_iterations: 0,
      autonomous_model: null,
      orchestration_budgets_json: JSON.stringify({ maxReactWallClockMs: 1000 }),
      position: 0,
      created_at: '',
      updated_at: '',
    } as KanbanEpicRow;
    const r = resolveOrchestrationBudgets(project, epic);
    expect(r.maxContinuationDepth).toBe(3);
    expect(r.maxReactWallClockMs).toBe(1000);
  });

  it('finalize clamps maxReactActionsPerTurn to parse cap', () => {
    const r = finalizeResolvedBudgets({
      ...DEFAULT_ORCHESTRATION_BUDGETS,
      maxReactActionsPerTurn: 99,
    });
    expect(r.maxReactActionsPerTurn).toBe(12);
  });
});

describe('evaluateReactContinuationBudgets', () => {
  const budgets = DEFAULT_ORCHESTRATION_BUDGETS;

  it('returns ok=false without reasons when react context missing', () => {
    const r = evaluateReactContinuationBudgets({
      reactLoopEnabled: true,
      continuationContextAdded: false,
      controlFlowPresent: false,
      continuationDepth: 0,
      chainStartedAtMs: 0,
      nowMs: 10_000,
      budgets,
    });
    expect(r.ok).toBe(false);
    expect(r.reasons).toEqual([]);
  });

  it('blocks when continuation depth reaches cap', () => {
    const r = evaluateReactContinuationBudgets({
      reactLoopEnabled: true,
      continuationContextAdded: true,
      controlFlowPresent: false,
      continuationDepth: 4,
      chainStartedAtMs: 0,
      nowMs: 100,
      budgets,
    });
    expect(r.ok).toBe(false);
    expect(r.reasons.some((x) => x.includes('continuation depth'))).toBe(true);
  });

  it('blocks on wall clock when configured', () => {
    const r = evaluateReactContinuationBudgets({
      reactLoopEnabled: true,
      continuationContextAdded: true,
      controlFlowPresent: false,
      continuationDepth: 0,
      chainStartedAtMs: 0,
      nowMs: 2000,
      budgets: { ...budgets, maxReactWallClockMs: 1000 },
    });
    expect(r.ok).toBe(false);
    expect(r.reasons.some((x) => x.includes('wall clock'))).toBe(true);
  });

  it('allows when within caps', () => {
    const r = evaluateReactContinuationBudgets({
      reactLoopEnabled: true,
      continuationContextAdded: true,
      controlFlowPresent: false,
      continuationDepth: 1,
      chainStartedAtMs: 0,
      nowMs: 500,
      budgets,
    });
    expect(r.ok).toBe(true);
  });
});

describe('parseEpicOrchestrationBudgetsJson', () => {
  it('returns null on invalid JSON', () => {
    expect(parseEpicOrchestrationBudgetsJson('{')).toBeNull();
  });
});

describe('projectOrchestrationDefaults', () => {
  it('uses defaults when project has no budgets', () => {
    const p = { id: 'x', name: 'n', cwd: '/', ahw: '/', agents: [] } as unknown as Project;
    expect(projectOrchestrationDefaults(p).maxContinuationDepth).toBe(4);
  });
});
