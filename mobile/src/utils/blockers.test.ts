// @ts-nocheck
import { describe, it, expect } from 'vitest';
import { hasUnresolvedBlockers, isColumnBlockerSensitive, shouldConfirmMove } from './blockers';
describe('hasUnresolvedBlockers', () => {
  it('returns false for empty / missing blockers', () => {
    expect(hasUnresolvedBlockers({})).toBe(false);
    expect(hasUnresolvedBlockers({ blockers: [] })).toBe(false);
    expect(hasUnresolvedBlockers(null)).toBe(false);
  });
  it('returns false when all blockers are done', () => {
    expect(hasUnresolvedBlockers({ blockers: [{ done: true }, { done: true }] })).toBe(false);
  });
  it('returns true when any blocker is unresolved', () => {
    expect(hasUnresolvedBlockers({ blockers: [{ done: true }, { done: false }] })).toBe(true);
  });
});
describe('isColumnBlockerSensitive', () => {
  it('returns false for Done variants', () => {
    expect(isColumnBlockerSensitive('Done')).toBe(false);
    expect(isColumnBlockerSensitive('Deployed / Done')).toBe(false);
  });
  it('returns false for "Backlog" as back-compat for custom boards', () => {
    // Default boards no longer seed a Backlog column, but custom boards may
    // still carry one — keep treating it as blocker-insensitive.
    expect(isColumnBlockerSensitive('Backlog')).toBe(false);
  });
  it('returns true for In Progress, Review, and other columns', () => {
    expect(isColumnBlockerSensitive('In Progress')).toBe(true);
    expect(isColumnBlockerSensitive('Review')).toBe(true);
    expect(isColumnBlockerSensitive('QA')).toBe(true);
  });
  it('returns true for null / empty (fail toward prompting)', () => {
    expect(isColumnBlockerSensitive(null)).toBe(true);
    expect(isColumnBlockerSensitive('')).toBe(true);
  });
});
describe('shouldConfirmMove', () => {
  const card = (blockers: any) => ({ id: 'c', blockers });
  it('skips when no unresolved blockers', () => {
    expect(
      shouldConfirmMove(card([{ done: true }]), 'src', { id: 'tgt', name: 'In Progress' }),
    ).toBe(false);
  });
  it('skips when target is Done', () => {
    expect(shouldConfirmMove(card([{ done: false }]), 'src', { id: 'd', name: 'Done' })).toBe(
      false,
    );
  });
  it('skips when target is "Backlog" (back-compat for custom boards)', () => {
    expect(shouldConfirmMove(card([{ done: false }]), 'src', { id: 'b', name: 'Backlog' })).toBe(
      false,
    );
  });
  it('prompts when blocked card moves into sensitive column', () => {
    expect(
      shouldConfirmMove(card([{ done: false }]), 'src', { id: 'p', name: 'In Progress' }),
    ).toBe(true);
  });
});
