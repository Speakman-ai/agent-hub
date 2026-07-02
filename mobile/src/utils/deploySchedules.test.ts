import { describe, expect, it } from 'vitest';
import {
  DEPLOY_SCHEDULE_CRON_MAX_LENGTH,
  DEPLOY_SCHEDULE_REF_MAX_LENGTH,
  describeSchedule,
  sortSchedules,
  validateScheduleDraft,
} from './deploySchedules';

describe('mobile deploySchedules helpers', () => {
  it('describes a schedule', () => {
    expect(describeSchedule({ ref: 'main', cron: '0 9 * * *' })).toBe('Deploy main on 0 9 * * *');
  });

  it('sorts by ref then cron without mutating input', () => {
    const input = [
      { ref: 'release', cron: '0 9 * * *' },
      { ref: 'main', cron: '30 2 * * *' },
      { ref: 'main', cron: '0 2 * * *' },
    ];
    const sorted = sortSchedules(input);
    expect(sorted.map((s) => `${s.ref}@${s.cron}`)).toEqual([
      'main@0 2 * * *',
      'main@30 2 * * *',
      'release@0 9 * * *',
    ]);
    expect(input[0].ref).toBe('release');
  });

  it('validates drafts like the store', () => {
    expect(validateScheduleDraft({ ref: 'main', cron: '0 9 * * *' })).toBeNull();
    expect(validateScheduleDraft({ ref: '', cron: '0 9 * * *' })).toMatch(/Ref is required/);
    expect(validateScheduleDraft({ ref: 'main', cron: '' })).toMatch(/Cron expression is required/);
    expect(
      validateScheduleDraft({ ref: 'x'.repeat(DEPLOY_SCHEDULE_REF_MAX_LENGTH + 1), cron: '0 9 * * *' }),
    ).toMatch(/Ref must be/);
    expect(
      validateScheduleDraft({ ref: 'main', cron: '*'.repeat(DEPLOY_SCHEDULE_CRON_MAX_LENGTH + 1) }),
    ).toMatch(/Cron must be/);
  });
});
