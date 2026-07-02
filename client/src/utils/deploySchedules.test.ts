import { describe, expect, it } from 'vitest';
import {
  DEPLOY_SCHEDULE_CRON_MAX_LENGTH,
  DEPLOY_SCHEDULE_REF_MAX_LENGTH,
  describeSchedule,
  sortSchedules,
  validateScheduleDraft,
} from './deploySchedules';

describe('sortSchedules', () => {
  it('sorts by ref then cron and does not mutate the input', () => {
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
    // original array order untouched
    expect(input[0].ref).toBe('release');
  });
});

describe('describeSchedule', () => {
  it('renders a human sentence', () => {
    expect(describeSchedule({ ref: 'main', cron: '0 9 * * *' })).toBe('Deploy main on 0 9 * * *');
  });
});

describe('validateScheduleDraft', () => {
  it('accepts a valid draft', () => {
    expect(validateScheduleDraft({ ref: 'main', cron: '0 9 * * *' })).toBeNull();
  });

  it('rejects an empty ref', () => {
    expect(validateScheduleDraft({ ref: '   ', cron: '0 9 * * *' })).toBe('Ref is required.');
  });

  it('rejects an empty cron', () => {
    expect(validateScheduleDraft({ ref: 'main', cron: '  ' })).toBe('Cron expression is required.');
  });

  it('rejects an over-long ref', () => {
    const ref = 'a'.repeat(DEPLOY_SCHEDULE_REF_MAX_LENGTH + 1);
    expect(validateScheduleDraft({ ref, cron: '0 9 * * *' })).toMatch(/Ref must be/);
  });

  it('rejects an over-long cron', () => {
    const cron = '*'.repeat(DEPLOY_SCHEDULE_CRON_MAX_LENGTH + 1);
    expect(validateScheduleDraft({ ref: 'main', cron })).toMatch(/Cron must be/);
  });
});
