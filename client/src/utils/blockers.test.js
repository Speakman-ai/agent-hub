import { describe, it, expect } from 'vitest';
import { hasUnresolvedBlockers, isColumnBlockerSensitive, shouldConfirmMove } from './blockers.js';

describe('hasUnresolvedBlockers', () => {
  it('returns false when card has no blockers field', () => {
    expect(hasUnresolvedBlockers({})).toBe(false);
  });

  it('returns false when blockers array is empty', () => {
    expect(hasUnresolvedBlockers({ blockers: [] })).toBe(false);
  });

  it('returns false when every blocker is done', () => {
    expect(
      hasUnresolvedBlockers({
        blockers: [
          { id: 'a', done: true },
          { id: 'b', done: true },
        ],
      }),
    ).toBe(false);
  });

  it('returns true when any blocker is not done', () => {
    expect(
      hasUnresolvedBlockers({
        blockers: [
          { id: 'a', done: true },
          { id: 'b', done: false },
        ],
      }),
    ).toBe(true);
  });

  it('returns false when card is null/undefined', () => {
    expect(hasUnresolvedBlockers(null)).toBe(false);
    expect(hasUnresolvedBlockers(undefined)).toBe(false);
  });
});

describe('isColumnBlockerSensitive', () => {
  it('returns false for "Backlog" variants (back-compat for custom boards)', () => {
    // The default seeded board no longer includes a Backlog column. Custom
    // boards may still carry one, and the predicate keeps treating those
    // lanes as blocker-insensitive so the confirm dialog doesn't fire when
    // dragging a blocked card back into them.
    expect(isColumnBlockerSensitive('Backlog')).toBe(false);
    expect(isColumnBlockerSensitive('backlog')).toBe(false);
    expect(isColumnBlockerSensitive('Project Backlog')).toBe(false);
  });

  it('returns false for Done variants', () => {
    expect(isColumnBlockerSensitive('Done')).toBe(false);
    expect(isColumnBlockerSensitive('done')).toBe(false);
    expect(isColumnBlockerSensitive('Done ✅')).toBe(false);
    expect(isColumnBlockerSensitive('Deployed / Done')).toBe(false);
  });

  it('returns true for other columns', () => {
    expect(isColumnBlockerSensitive('To Do')).toBe(true);
    expect(isColumnBlockerSensitive('In Progress')).toBe(true);
    expect(isColumnBlockerSensitive('QA')).toBe(true);
  });

  it('returns true for null/empty (fail-safe toward prompting)', () => {
    expect(isColumnBlockerSensitive(null)).toBe(true);
    expect(isColumnBlockerSensitive('')).toBe(true);
  });
});

describe('shouldConfirmMove', () => {
  const card = (blockers) => ({ id: 'c', blockers });

  it('returns false when card has no unresolved blockers', () => {
    expect(
      shouldConfirmMove(card([{ id: 'a', done: true }]), 'col-todo', {
        id: 'col-progress',
        name: 'In Progress',
      }),
    ).toBe(false);
  });

  it('returns false when staying in the same column', () => {
    expect(
      shouldConfirmMove(card([{ id: 'a', done: false }]), 'col-same', {
        id: 'col-same',
        name: 'In Progress',
      }),
    ).toBe(false);
  });

  it('returns false when target is "Backlog" (back-compat for custom boards)', () => {
    expect(
      shouldConfirmMove(card([{ id: 'a', done: false }]), 'col-progress', {
        id: 'col-backlog',
        name: 'Backlog',
      }),
    ).toBe(false);
  });

  it('returns false when target is Done', () => {
    expect(
      shouldConfirmMove(card([{ id: 'a', done: false }]), 'col-progress', {
        id: 'col-done',
        name: 'Done',
      }),
    ).toBe(false);
  });

  it('returns true when moving a blocked card into a sensitive column', () => {
    expect(
      shouldConfirmMove(card([{ id: 'a', done: false }]), 'col-todo', {
        id: 'col-progress',
        name: 'In Progress',
      }),
    ).toBe(true);
  });

  it('returns false when card or target is missing', () => {
    expect(shouldConfirmMove(null, 'a', { id: 'b', name: 'In Progress' })).toBe(false);
    expect(shouldConfirmMove(card([{ id: 'a', done: false }]), 'a', null)).toBe(false);
  });
});
