import { describe, expect, it } from 'vitest';
import {
  DEPLOY_TRIGGER_BRANCH_PATTERN_MAX_LENGTH,
  DEPLOY_TRIGGER_EVENTS,
  describeTrigger,
  sortTriggers,
  triggerEventLabel,
  validateTriggerDraft,
} from './deployTriggers';

describe('mobile deployTriggers helpers', () => {
  it('exposes the push/merge event set', () => {
    expect(DEPLOY_TRIGGER_EVENTS).toEqual(['push', 'merge']);
  });

  it('labels and describes triggers', () => {
    expect(triggerEventLabel('merge')).toBe('Merge');
    expect(describeTrigger({ event: 'push', branchPattern: 'main' })).toBe('On push to main');
  });

  it('sorts push before merge then by pattern', () => {
    const sorted = sortTriggers([
      { event: 'merge', branchPattern: 'a' },
      { event: 'push', branchPattern: 'b' },
    ]);
    expect(sorted[0].event).toBe('push');
  });

  it('validates drafts like the store', () => {
    expect(validateTriggerDraft({ event: 'push', branchPattern: 'main' })).toBeNull();
    expect(validateTriggerDraft({ event: 'push', branchPattern: '' })).toMatch(/required/);
    expect(validateTriggerDraft({ event: 'nope', branchPattern: 'main' })).toMatch(/push or merge/);
    expect(
      validateTriggerDraft({
        event: 'push',
        branchPattern: 'x'.repeat(DEPLOY_TRIGGER_BRANCH_PATTERN_MAX_LENGTH + 1),
      }),
    ).toMatch(/characters or fewer/);
  });
});
