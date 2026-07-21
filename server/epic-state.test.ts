import { describe, it, expect } from 'vitest';
import { computeEpicState } from './epic-state.js';

const columns = [
  { id: 'todo', name: 'To Do' },
  { id: 'wip', name: 'In Progress' },
  { id: 'done', name: 'Done' },
  { id: 'cancel', name: 'Canceled' },
];

describe('computeEpicState — cancelled cards', () => {
  it('returns null when every card is cancelled (no live tickets)', () => {
    const cards = [{ column_id: 'cancel' }, { column_id: 'cancel' }];
    expect(computeEpicState(cards, columns)).toBeNull();
  });

  it('reads done when all live cards are done and the rest are cancelled', () => {
    // Regression: a cancelled card in a non-done column used to pin the epic at
    // in_progress forever. Cancelled work must not count.
    const cards = [{ column_id: 'done' }, { column_id: 'cancel' }];
    expect(computeEpicState(cards, columns)).toBe('done');
  });

  it('ignores cancelled cards when deciding not_started vs in_progress', () => {
    const cards = [{ column_id: 'todo' }, { column_id: 'cancel' }];
    expect(computeEpicState(cards, columns)).toBe('not_started');
  });

  it('still reports in_progress from live cards regardless of cancelled ones', () => {
    const cards = [{ column_id: 'wip' }, { column_id: 'cancel' }];
    expect(computeEpicState(cards, columns)).toBe('in_progress');
  });

  it('matches the British "Cancelled" spelling too', () => {
    const british = [
      { id: 'done', name: 'Done' },
      { id: 'cancel', name: 'Cancelled' },
    ];
    expect(computeEpicState([{ column_id: 'done' }, { column_id: 'cancel' }], british)).toBe(
      'done',
    );
  });

  it('is unchanged for epics with no cancelled cards', () => {
    expect(computeEpicState([{ column_id: 'todo' }], columns)).toBe('not_started');
    expect(computeEpicState([{ column_id: 'wip' }], columns)).toBe('in_progress');
    expect(computeEpicState([{ column_id: 'done' }], columns)).toBe('done');
    expect(computeEpicState([], columns)).toBeNull();
  });
});
