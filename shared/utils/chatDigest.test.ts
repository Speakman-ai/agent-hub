import { describe, it, expect } from 'vitest';
import {
  canUseMyWorkDigestScope,
  chatDigestStatusText,
  describeDigestSchedule,
  digestScopeReady,
  splitDigestCron,
} from './chatDigest.js';

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

describe('splitDigestCron', () => {
  it('splits on | and normalizes each expression', () => {
    expect(splitDigestCron(' 0  8 * * * |30 9 * * *| ')).toEqual(['0 8 * * *', '30 9 * * *']);
    expect(splitDigestCron('0 9 * * 1-5')).toEqual(['0 9 * * 1-5']);
  });

  it('describes every expression of a joined schedule', () => {
    const text = describeDigestSchedule('0 8 * * * | 30 9 * * *', 'UTC');
    expect(text.split('; ')).toHaveLength(2);
    expect(text).toContain('(UTC)');
  });
});

describe('canUseMyWorkDigestScope', () => {
  it("allows only the viewer's own Summaries channel", () => {
    expect(canUseMyWorkDigestScope({ kind: 'summary', createdByUserId: 'u1' }, 'u1')).toBe(true);
    expect(canUseMyWorkDigestScope({ kind: 'summary', createdByUserId: 'u2' }, 'u1')).toBe(false);
    expect(canUseMyWorkDigestScope({ kind: 'channel', createdByUserId: 'u1' }, 'u1')).toBe(false);
    expect(canUseMyWorkDigestScope({ kind: 'summary', createdByUserId: null }, null)).toBe(false);
  });
});

describe('digestScopeReady', () => {
  it('needs projects only for the project scope', () => {
    expect(digestScopeReady('project', [])).toBe(false);
    expect(digestScopeReady('project', ['web'])).toBe(true);
    expect(digestScopeReady('channel', [])).toBe(true);
    expect(digestScopeReady('my_work', [])).toBe(true);
  });
});
