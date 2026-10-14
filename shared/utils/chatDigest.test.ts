import { describe, it, expect } from 'vitest';
import { chatDigestStatusText, describeDigestSchedule } from './chatDigest.js';

const fmt = (iso: string) => iso.slice(0, 16);

describe('chatDigestStatusText', () => {
  it('reports no digest, not-yet-run, posted and skipped runs', () => {
    expect(chatDigestStatusText(null)).toBe('No digest scheduled.');
    const base = { enabled: true, lastRunAt: null, lastStatus: null, lastError: null };
    expect(chatDigestStatusText(base, fmt)).toBe('Not run yet.');
    expect(
      chatDigestStatusText(
        { ...base, lastRunAt: '2026-10-14T09:00:00Z', lastStatus: 'posted' },
        fmt,
      ),
    ).toBe('Last run 2026-10-14T09:00: posted a digest.');
    expect(
      chatDigestStatusText(
        { ...base, enabled: false, lastRunAt: '2026-10-14T09:00:00Z', lastStatus: 'skipped' },
        fmt,
      ),
    ).toBe('Paused. Last run 2026-10-14T09:00: nothing new, skipped posting.');
  });

  it('surfaces the failure reason', () => {
    expect(
      chatDigestStatusText(
        { enabled: true, lastRunAt: null, lastStatus: 'error', lastError: 'no engine' },
        fmt,
      ),
    ).toBe('Last run failed: no engine');
  });
});

describe('describeDigestSchedule', () => {
  it('describes the cron and names the zone', () => {
    expect(describeDigestSchedule('0 9 * * *', 'UTC')).toContain('(UTC)');
    expect(describeDigestSchedule('not a cron', '')).toBe('not a cron');
  });
});
