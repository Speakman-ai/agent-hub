import { describe, expect, it } from 'vitest';
import {
  DEPLOY_TRIGGER_BRANCH_PATTERN_MAX_LENGTH,
  DEPLOY_TRIGGER_EVENTS,
  describeTrigger,
  sortTriggers,
  triggerEventLabel,
  validateTriggerDraft,
} from './deployTriggers';

describe('deployTriggers helpers', () => {
  it('exposes the push/merge event set', () => {
    expect(DEPLOY_TRIGGER_EVENTS).toEqual(['push', 'merge']);
  });

  it('labels events for display', () => {
    expect(triggerEventLabel('push')).toBe('Push');
    expect(triggerEventLabel('merge')).toBe('Merge');
    expect(triggerEventLabel('other')).toBe('other');
  });

  it('describes a trigger as a human sentence', () => {
    expect(describeTrigger({ event: 'push', branchPattern: 'main' })).toBe('On push to main');
    expect(describeTrigger({ event: 'merge', branchPattern: 'release/*' })).toBe(
      'On merge to release/*',
    );
  });

  it('sorts push before merge, then by branch pattern', () => {
    const sorted = sortTriggers([
      { event: 'merge', branchPattern: 'zeta' },
      { event: 'push', branchPattern: 'beta' },
      { event: 'push', branchPattern: 'alpha' },
      { event: 'merge', branchPattern: 'alpha' },
    ]);
    expect(sorted.map((t) => `${t.event}:${t.branchPattern}`)).toEqual([
      'push:alpha',
      'push:beta',
      'merge:alpha',
      'merge:zeta',
    ]);
  });

  it('does not mutate the input array when sorting', () => {
    const input = [
      { event: 'merge' as const, branchPattern: 'b' },
      { event: 'push' as const, branchPattern: 'a' },
    ];
    const sorted = sortTriggers(input);
    expect(input[0].event).toBe('merge');
    expect(sorted).not.toBe(input);
  });

  describe('validateTriggerDraft', () => {
    it('accepts a valid draft', () => {
      expect(validateTriggerDraft({ event: 'push', branchPattern: 'main' })).toBeNull();
      expect(validateTriggerDraft({ event: 'merge', branchPattern: '  release/*  ' })).toBeNull();
    });

    it('rejects an unknown event', () => {
      expect(validateTriggerDraft({ event: 'deploy', branchPattern: 'main' })).toMatch(
        /push or merge/,
      );
    });

    it('rejects an empty / whitespace branch pattern', () => {
      expect(validateTriggerDraft({ event: 'push', branchPattern: '' })).toMatch(/required/);
      expect(validateTriggerDraft({ event: 'push', branchPattern: '   ' })).toMatch(/required/);
    });

    it('rejects an over-long branch pattern', () => {
      const pattern = 'x'.repeat(DEPLOY_TRIGGER_BRANCH_PATTERN_MAX_LENGTH + 1);
      expect(validateTriggerDraft({ event: 'push', branchPattern: pattern })).toMatch(
        /characters or fewer/,
      );
    });

    it('accepts a pattern exactly at the max length', () => {
      const pattern = 'x'.repeat(DEPLOY_TRIGGER_BRANCH_PATTERN_MAX_LENGTH);
      expect(validateTriggerDraft({ event: 'push', branchPattern: pattern })).toBeNull();
    });
  });
});
