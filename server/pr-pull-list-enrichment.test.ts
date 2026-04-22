import { describe, it, expect } from 'vitest';
import { normalizeCheckRollupItems, rollupStateToCheckItems } from './pr-pull-list-enrichment.js';

describe('rollupStateToCheckItems', () => {
  it('maps SUCCESS to a passing synthetic check row', () => {
    const rows = rollupStateToCheckItems('SUCCESS');
    expect(rows).toHaveLength(1);
    expect(rows[0].conclusion).toBe('success');
    expect(rows[0].status).toBe('completed');
  });

  it('maps PENDING / EXPECTED to in-flight', () => {
    expect(rollupStateToCheckItems('PENDING')[0].status).toBe('queued');
    expect(rollupStateToCheckItems('EXPECTED')[0].status).toBe('queued');
  });

  it('maps FAILURE / ERROR to failure', () => {
    expect(rollupStateToCheckItems('FAILURE')[0].conclusion).toBe('failure');
    expect(rollupStateToCheckItems('ERROR')[0].conclusion).toBe('failure');
  });

  it('returns empty for unknown / empty', () => {
    expect(rollupStateToCheckItems('')).toEqual([]);
    expect(rollupStateToCheckItems(null)).toEqual([]);
  });

  it('maps unknown aggregate state to in-flight (not neutral-as-success)', () => {
    const rows = rollupStateToCheckItems('OTHER');
    expect(rows[0].status).toBe('queued');
    expect(rows[0].conclusion).toBe('');
  });
});

describe('normalizeCheckRollupItems', () => {
  it('normalizes gh CheckRun rows', () => {
    const out = normalizeCheckRollupItems([
      { __typename: 'CheckRun', name: 'CI', status: 'COMPLETED', conclusion: 'SUCCESS' },
    ]);
    expect(out[0]).toMatchObject({ name: 'CI', status: 'COMPLETED', conclusion: 'SUCCESS' });
  });

  it('normalizes StatusContext SUCCESS to completed success', () => {
    const out = normalizeCheckRollupItems([
      { __typename: 'StatusContext', context: 'ci/context', state: 'SUCCESS' },
    ]);
    expect(out[0].name).toBe('ci/context');
    expect(out[0].status).toBe('COMPLETED');
    expect(out[0].conclusion).toBe('success');
  });

  it('maps StatusContext EXPECTED and PENDING to in-flight (not success)', () => {
    const expected = normalizeCheckRollupItems([
      { __typename: 'StatusContext', context: 'legacy', state: 'EXPECTED' },
    ]);
    expect(expected[0].status).toBe('queued');
    expect(expected[0].conclusion).toBe('');

    const pending = normalizeCheckRollupItems([
      { __typename: 'StatusContext', context: 'legacy2', state: 'PENDING' },
    ]);
    expect(pending[0].status).toBe('queued');
    expect(pending[0].conclusion).toBe('');
  });

  it('maps StatusContext FAILURE and ERROR to failure', () => {
    expect(
      normalizeCheckRollupItems([
        { __typename: 'StatusContext', context: 'x', state: 'FAILURE' },
      ])[0].conclusion,
    ).toBe('failure');
    expect(
      normalizeCheckRollupItems([{ __typename: 'StatusContext', context: 'y', state: 'ERROR' }])[0]
        .conclusion,
    ).toBe('failure');
  });

  it('ignores junk', () => {
    expect(normalizeCheckRollupItems(null)).toEqual([]);
    expect(normalizeCheckRollupItems([{ foo: 1 }])).toEqual([]);
  });
});
