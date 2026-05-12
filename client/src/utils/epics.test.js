import { describe, it, expect } from 'vitest';
import { epicFormToUpdateBody, epicFormToCreateBody, DEFAULT_EPIC_COLOR } from './epics.js';

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
      prBaseBranch: null,
    });
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
      autonomous_model: 'claude-opus-4-7',
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
    const body = epicFormToUpdateBody({ name: 'x', autonomous: 1 });
    expect(body.autonomousInterval).toBe(5);
    expect(body.autonomousMaxConcurrent).toBe(2);
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
    });
  });

  it('trims the name and falls back to the default color', () => {
    expect(epicFormToCreateBody({ name: '  hi  ' })).toEqual({
      name: 'hi',
      description: '',
      color: DEFAULT_EPIC_COLOR,
    });
  });
});
