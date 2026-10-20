import { describe, expect, it } from 'vitest';
import {
  inheritedFailuresCardPath,
  inheritedFailuresLabel,
  readInheritedFailures,
} from './inheritedFailures';

const summary = { count: 2, instances: [], breakageId: 'b1', cardId: 'card-1' };

describe('inherited failures display', () => {
  it('reads the JSON column off a run row', () => {
    expect(readInheritedFailures({ inherited_failures: JSON.stringify(summary) })).toEqual({
      count: 2,
      cardId: 'card-1',
    });
    expect(readInheritedFailures({ inherited_failures: summary })).toEqual({
      count: 2,
      cardId: 'card-1',
    });
  });

  it('returns null for runs without inherited failures', () => {
    expect(readInheritedFailures(null)).toBeNull();
    expect(readInheritedFailures({ inherited_failures: null })).toBeNull();
    expect(readInheritedFailures({ inherited_failures: '{bad' })).toBeNull();
    expect(readInheritedFailures({ inherited_failures: '{"count":0}' })).toBeNull();
  });

  it('labels the run and links the breakage card', () => {
    const run = { inherited_failures: JSON.stringify(summary) };
    expect(inheritedFailuresLabel(run)).toBe('Tested (inherited failures: 2)');
    expect(inheritedFailuresCardPath('agent-hub', run)).toBe(
      '/projects/agent-hub/board?card=card-1',
    );
    expect(
      inheritedFailuresCardPath('agent-hub', { inherited_failures: '{"count":1}' }),
    ).toBeNull();
  });
});
