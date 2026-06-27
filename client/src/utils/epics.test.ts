import { describe, it, expect } from 'vitest';
import {
  epicFormToUpdateBody,
  epicFormToCreateBody,
  epicsWithActiveCards,
  phaseFormToUpdateBody,
  autonomousModelOptions,
  defaultAutonomousModel,
  DEFAULT_EPIC_COLOR,
} from './epics';

describe('epicsWithActiveCards', () => {
  const epics = [
    { id: 'e1', name: 'Platform' },
    { id: 'e2', name: 'Mobile' },
    { id: 'e3', name: 'Empty' },
  ];
  const countFor = (id: any) => (({ e1: 3, e2: 1, e3: 0 }) as Record<string, any>)[id] ?? 0;

  it('drops epics with zero active cards', () => {
    const visible = epicsWithActiveCards(epics, countFor, null);
    expect(visible.map((e: any) => e.id)).toEqual(['e1', 'e2']);
  });

  it('keeps the selected epic even when its active count is 0', () => {
    const visible = epicsWithActiveCards(epics, countFor, 'e3');
    expect(visible.map((e: any) => e.id)).toEqual(['e1', 'e2', 'e3']);
  });

  it('returns all epics when no count function is provided', () => {
    expect(epicsWithActiveCards(epics, undefined, null)).toEqual(epics);
  });

  it('returns an empty array for a non-array input', () => {
    expect(epicsWithActiveCards(null, countFor, null)).toEqual([]);
  });
});

describe('epicFormToUpdateBody', () => {
  it('emits the camelCase keys the server PUT endpoint expects', () => {
    // Regression: the form uses snake_case keys (mirroring DB columns) but
    // PUT /board/epics/:id destructures camelCase. Without this translation,
    // the autonomous_max_concurrent value silently fell through to the old
    // DB value — the "max agents setting has no effect" bug.
    const form = {
      name: '  Trim me  ',
      description: 'desc',
      color: '#EC4899',
      autonomous: 1,
      autonomous_interval: 7,
      autonomous_max_concurrent: 3,
    };
    expect(epicFormToUpdateBody(form)).toEqual({
      name: 'Trim me',
      description: 'desc',
      color: '#EC4899',
      autonomous: 1,
      autonomousInterval: 7,
      autonomousMaxConcurrent: 3,
      autonomousModel: null,
      autonomousSendIt: 0,
      prBaseBranch: null,
      labels: null,
      assignedUserId: null,
    });
  });

  it('sends autonomousSendIt 1 when the Auto Merge toggle is on and autonomous is on', () => {
    const body = epicFormToUpdateBody({
      name: 'x',
      autonomous: 1,
      autonomous_send_it: 1,
    });
    expect(body.autonomousSendIt).toBe(1);
  });

  it('forces autonomousSendIt 0 when autonomous is off (clears the override)', () => {
    const body = epicFormToUpdateBody({
      name: 'x',
      autonomous: 0,
      autonomous_send_it: 1,
    });
    expect(body.autonomousSendIt).toBe(0);
  });

  it('preserves user-supplied max_concurrent (not defaults)', () => {
    // If we accidentally re-applied defaults here, the bug would remain — so
    // assert that the exact user values round-trip into the request body.
    const body = epicFormToUpdateBody({
      name: 'x',
      autonomous: 1,
      autonomous_max_concurrent: 4,
    });
    expect(body.autonomousMaxConcurrent).toBe(4);
    expect(body.autonomousModel).toBe(null);
  });

  it('passes trimmed autonomous_model when autonomous is on', () => {
    const body = epicFormToUpdateBody({
      name: 'x',
      autonomous: 1,
      autonomous_model: '  claude-sonnet-4-6  ',
    });
    expect(body.autonomousModel).toBe('claude-sonnet-4-6');
  });

  it('sends autonomousModel null when autonomous is off (clears epic override)', () => {
    const body = epicFormToUpdateBody({
      name: 'x',
      autonomous: 0,
      autonomous_model: 'claude-opus-4-8',
    });
    expect(body.autonomous).toBe(0);
    expect(body.autonomousModel).toBe(null);
  });

  it('coerces autonomous falsy values to 0', () => {
    expect(epicFormToUpdateBody({ name: 'a', autonomous: false }).autonomous).toBe(0);
    expect(epicFormToUpdateBody({ name: 'a', autonomous: undefined }).autonomous).toBe(0);
    expect(epicFormToUpdateBody({ name: 'a', autonomous: 0 }).autonomous).toBe(0);
  });

  it('applies sensible fallbacks when autonomous fields are missing', () => {
    // Default "tickets at once" is 1 — dispatch one card at a time unless the
    // operator raises it. (Was 2; lowered so autonomous/run-phase dispatch is
    // conservative by default.)
    const body = epicFormToUpdateBody({ name: 'x', autonomous: 1 });
    expect(body.autonomousInterval).toBe(5);
    expect(body.autonomousMaxConcurrent).toBe(1);
    expect(body.autonomousModel).toBe(null);
  });

  it('falls back to DEFAULT_EPIC_COLOR when color is missing', () => {
    expect(epicFormToUpdateBody({ name: 'x' }).color).toBe(DEFAULT_EPIC_COLOR);
  });

  it('includes orchestrationBudgets when provided on the form', () => {
    const body = epicFormToUpdateBody({
      name: 'x',
      autonomous: 0,
      orchestrationBudgets: { maxContinuationDepth: 2 },
    });
    expect(body.orchestrationBudgets).toEqual({ maxContinuationDepth: 2 });
  });
});

describe('phaseFormToUpdateBody', () => {
  it('defaults "tickets at once" (max concurrent) to 1 when unset', () => {
    const body = phaseFormToUpdateBody({ name: 'Build', autonomous: 1 });
    expect(body.autonomousMaxConcurrent).toBe(1);
    expect(body.autonomousInterval).toBe(5);
  });

  it('round-trips an explicit max_concurrent and the autonomous toggle', () => {
    const body = phaseFormToUpdateBody({
      name: 'Build',
      autonomous: 1,
      autonomous_max_concurrent: 3,
    });
    expect(body).toEqual({
      name: 'Build',
      description: '',
      autonomous: 1,
      autonomousInterval: 5,
      autonomousMaxConcurrent: 3,
      autonomousModel: null,
      autonomousSendIt: 0,
    });
  });

  it('preserves a selected model even when auto-dispatch is off', () => {
    const body = phaseFormToUpdateBody({
      name: 'Build',
      autonomous: 0,
      autonomous_model: '  gpt-5.5  ',
    });
    expect(body.autonomousModel).toBe('gpt-5.5');
  });
});

describe('autonomous model helpers', () => {
  const modelConfig = {
    defaultModel: 'gpt-5.5',
    engineDefaultModels: {
      'claude-code': 'claude-opus-4-8',
      'codex-cli': 'gpt-5.5',
    },
    engineValidModels: {
      'claude-code': ['claude-opus-4-8'],
      'codex-cli': ['gpt-5.5', 'gpt-5.4'],
    },
  };

  it('flattens authenticated model options across engines', () => {
    expect(autonomousModelOptions(modelConfig)).toEqual(['claude-opus-4-8', 'gpt-5.5', 'gpt-5.4']);
  });

  it('uses the configured default model when it is available', () => {
    expect(defaultAutonomousModel(modelConfig)).toBe('gpt-5.5');
  });

  it('falls back to the first valid engine default when defaultModel is unavailable', () => {
    expect(defaultAutonomousModel({ ...modelConfig, defaultModel: 'missing-model' })).toBe(
      'claude-opus-4-8',
    );
  });
});

describe('epicFormToCreateBody', () => {
  it('only sends the subset supported by POST /board/epics', () => {
    const form = {
      name: 'New epic',
      description: 'desc',
      color: '#EAB308',
      autonomous: 1, // should be ignored — create endpoint doesn't accept it
      autonomous_interval: 10,
      autonomous_max_concurrent: 4,
    };
    expect(epicFormToCreateBody(form)).toEqual({
      name: 'New epic',
      description: 'desc',
      color: '#EAB308',
      labels: null,
      assignedUserId: null,
    });
  });

  it('normalizes labels on create', () => {
    expect(epicFormToCreateBody({ name: 'x', labels: ' platform , q1 , platform ' })).toEqual({
      name: 'x',
      description: '',
      color: DEFAULT_EPIC_COLOR,
      labels: 'platform, q1',
      assignedUserId: null,
    });
  });

  it('trims the name and falls back to the default color', () => {
    expect(epicFormToCreateBody({ name: '  hi  ' })).toEqual({
      name: 'hi',
      description: '',
      color: DEFAULT_EPIC_COLOR,
      labels: null,
      assignedUserId: null,
    });
  });
});
