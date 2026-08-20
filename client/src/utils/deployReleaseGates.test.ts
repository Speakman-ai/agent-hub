import { describe, it, expect } from 'vitest';
import {
  describeReleaseGate,
  describeReleaseGateProgress,
  normalizeReleaseGateRef,
  sortReleaseGates,
  validateReleaseGateDraft,
} from './deployReleaseGates';

describe('describeReleaseGate', () => {
  it('summarizes sessions + epics', () => {
    expect(describeReleaseGate({ ref: 'main', sessionIds: ['a', 'b'], epicIds: ['e'] })).toBe(
      'Deploy main when 2 sessions + 1 epic complete',
    );
  });
  it('handles a sessions-only gate', () => {
    expect(describeReleaseGate({ ref: 'main', sessionIds: ['a'], epicIds: [] })).toBe(
      'Deploy main when 1 session complete',
    );
  });
  it('handles an epics-only gate', () => {
    expect(describeReleaseGate({ ref: 'rel', sessionIds: [], epicIds: ['e1', 'e2'] })).toBe(
      'Deploy rel when 2 epics complete',
    );
  });
});

describe('describeReleaseGateProgress', () => {
  it('renders both counts', () => {
    expect(
      describeReleaseGateProgress({
        sessionsComplete: 2,
        sessionsTotal: 3,
        epicsComplete: 1,
        epicsTotal: 2,
      }),
    ).toBe('2/3 sessions · 1/2 epics');
  });
  it('omits an empty side', () => {
    expect(
      describeReleaseGateProgress({
        sessionsComplete: 1,
        sessionsTotal: 1,
        epicsComplete: 0,
        epicsTotal: 0,
      }),
    ).toBe('1/1 sessions');
  });
});

describe('sortReleaseGates', () => {
  it('orders armed → failed → fired, newest first within a status', () => {
    const order = sortReleaseGates([
      { status: 'fired', createdAt: '2026-01-01' },
      { status: 'armed', createdAt: '2026-01-01' },
      { status: 'armed', createdAt: '2026-01-02' },
      { status: 'failed', createdAt: '2026-01-01' },
    ]).map((g) => `${g.status}:${g.createdAt}`);
    expect(order).toEqual([
      'armed:2026-01-02',
      'armed:2026-01-01',
      'failed:2026-01-01',
      'fired:2026-01-01',
    ]);
  });
});

describe('validateReleaseGateDraft', () => {
  it('rejects a gate that watches nothing', () => {
    expect(validateReleaseGateDraft({ ref: 'main', sessionIds: [], epicIds: [] })).toMatch(
      /at least one/,
    );
  });
  it('accepts a sessions-only draft', () => {
    expect(validateReleaseGateDraft({ ref: '', sessionIds: ['s1'], epicIds: [] })).toBeNull();
  });
  it('rejects an over-long ref', () => {
    expect(
      validateReleaseGateDraft({ ref: 'x'.repeat(256), sessionIds: ['s1'], epicIds: [] }),
    ).toMatch(/characters or fewer/);
  });
});

describe('normalizeReleaseGateRef', () => {
  it('defaults a blank ref to main', () => {
    expect(normalizeReleaseGateRef('   ')).toBe('main');
    expect(normalizeReleaseGateRef('release-2')).toBe('release-2');
  });
});
