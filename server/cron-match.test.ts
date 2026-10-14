import { describe, it, expect } from 'vitest';
import { cronMatches, isValidCron, parseCron } from './cron-match.js';

describe('parseCron', () => {
  it('accepts standard 5-field expressions', () => {
    for (const expr of [
      '* * * * *',
      '0 9 * * 1-5',
      '*/15 * * * *',
      '0 9,17 1 jan,jul mon',
      '0 0 * * 7',
    ]) {
      expect(isValidCron(expr)).toBe(true);
    }
  });

  it('rejects malformed expressions', () => {
    for (const expr of [
      '',
      '* * * *',
      '* * * * * *',
      '60 * * * *',
      '* 24 * * *',
      '5-1 * * * *',
      '*/0 * * * *',
      'a * * * *',
      '1,,2 * * * *',
    ]) {
      expect(isValidCron(expr)).toBe(false);
    }
  });

  it('expands steps and treats 7 as Sunday', () => {
    expect([...(parseCron('*/20 * * * *')?.minutes ?? [])]).toEqual([0, 20, 40]);
    expect([...(parseCron('5/30 * * * *')?.minutes ?? [])]).toEqual([5, 35]);
    expect(parseCron('0 0 * * 7')?.daysOfWeek.has(0)).toBe(true);
  });
});

describe('cronMatches', () => {
  // 2026-10-14 is a Wednesday. 16:30 UTC is 09:30 in Los Angeles (PDT).
  const at = new Date('2026-10-14T16:30:20Z');

  it('reads the expression in the given timezone', () => {
    expect(cronMatches('30 9 * * *', at, 'America/Los_Angeles')).toBe(true);
    expect(cronMatches('30 9 * * *', at, 'UTC')).toBe(false);
    expect(cronMatches('30 16 * * *', at, 'UTC')).toBe(true);
  });

  it('honours weekday ranges and names', () => {
    expect(cronMatches('30 9 * * mon-fri', at, 'America/Los_Angeles')).toBe(true);
    expect(cronMatches('30 9 * * sat,sun', at, 'America/Los_Angeles')).toBe(false);
  });

  it('matches either day field when both are restricted', () => {
    expect(cronMatches('30 16 1 * wed', at, 'UTC')).toBe(true);
    expect(cronMatches('30 16 14 * mon', at, 'UTC')).toBe(true);
    expect(cronMatches('30 16 1 * mon', at, 'UTC')).toBe(false);
  });

  it('never matches an invalid expression or zone', () => {
    expect(cronMatches('nope', at, 'UTC')).toBe(false);
    expect(cronMatches('* * * * *', at, 'Not/AZone')).toBe(false);
  });

  it('applies steps on a wildcard day field', () => {
    // 2026-10-14 is day 14 (even) and a Wednesday (3, odd).
    expect(cronMatches('30 16 */2 * *', at, 'UTC')).toBe(false); // odd days 1,3,..
    expect(cronMatches('30 16 2-31/2 * *', at, 'UTC')).toBe(true);
    expect(cronMatches('30 16 * * */2', at, 'UTC')).toBe(false); // Sun, Tue, Thu, Sat
    expect(cronMatches('30 16 * * 1-5/2', at, 'UTC')).toBe(true); // Mon, Wed, Fri
    // A stepped wildcard field is ANDed with a restricted one, not ORed.
    expect(cronMatches('30 16 */2 * wed', at, 'UTC')).toBe(false);
    expect(cronMatches('30 16 */2 * thu', at, 'UTC')).toBe(false);
  });
});
