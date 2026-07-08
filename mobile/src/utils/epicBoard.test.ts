import { describe, expect, it } from 'vitest';
import { EPIC_BOARD_COLUMN_ORDER, epicBoardColumnKey, groupEpicsByState } from './epicBoard';

describe('epicBoardColumnKey (mobile)', () => {
  it('maps in_progress and done directly', () => {
    expect(epicBoardColumnKey('in_progress')).toBe('in_progress');
    expect(epicBoardColumnKey('done')).toBe('done');
  });

  it('treats not_started, null, undefined and unknown as not_started', () => {
    expect(epicBoardColumnKey('not_started')).toBe('not_started');
    expect(epicBoardColumnKey(null)).toBe('not_started');
    expect(epicBoardColumnKey(undefined)).toBe('not_started');
    expect(epicBoardColumnKey('weird')).toBe('not_started');
  });
});

describe('groupEpicsByState (mobile)', () => {
  it('returns three columns in fixed order with labels', () => {
    const cols = groupEpicsByState([]);
    expect(cols.map((c) => c.key)).toEqual(EPIC_BOARD_COLUMN_ORDER);
    expect(cols.map((c) => c.label)).toEqual(['Not started', 'In progress', 'Done']);
  });

  it('buckets epics by state, empty (null) under Not started', () => {
    const epics = [
      { id: 'a', state: 'in_progress' },
      { id: 'b', state: null },
      { id: 'c', state: 'done' },
      { id: 'd', state: 'not_started' },
    ];
    const [notStarted, inProgress, done] = groupEpicsByState(epics);
    expect(notStarted.epics.map((e) => e.id)).toEqual(['b', 'd']);
    expect(inProgress.epics.map((e) => e.id)).toEqual(['a']);
    expect(done.epics.map((e) => e.id)).toEqual(['c']);
  });
});
