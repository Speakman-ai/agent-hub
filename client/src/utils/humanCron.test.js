import { describe, it, expect } from 'vitest';
import humanCron from '../../../shared/utils/humanCron.js';

describe('humanCron', () => {
  it('returns empty string for invalid input', () => {
    expect(humanCron(null)).toBe('');
    expect(humanCron(undefined)).toBe('');
    expect(humanCron('')).toBe('');
    expect(humanCron(42)).toBe('');
  });

  it('returns raw expression for fewer than 5 parts', () => {
    expect(humanCron('* * *')).toBe('* * *');
    expect(humanCron('0 9')).toBe('0 9');
  });

  // Every minute
  it('handles every minute', () => {
    expect(humanCron('* * * * *')).toBe('Every minute');
    expect(humanCron('*/1 * * * *')).toBe('Every minute');
  });

  // Every N minutes
  it('handles every N minutes', () => {
    expect(humanCron('*/5 * * * *')).toBe('Every 5 minutes');
    expect(humanCron('*/15 * * * *')).toBe('Every 15 minutes');
    expect(humanCron('*/30 * * * *')).toBe('Every 30 minutes');
  });

  // Every hour
  it('handles every hour', () => {
    expect(humanCron('0 * * * *')).toBe('Every hour');
    expect(humanCron('15 * * * *')).toBe('Every hour at :15');
    expect(humanCron('45 * * * *')).toBe('Every hour at :45');
  });

  // Every N hours
  it('handles every N hours', () => {
    expect(humanCron('0 */2 * * *')).toBe('Every 2 hours');
    expect(humanCron('0 */6 * * *')).toBe('Every 6 hours');
    expect(humanCron('0 */1 * * *')).toBe('Every hour');
  });

  // Daily at specific time
  it('handles daily at specific time', () => {
    expect(humanCron('0 9 * * *')).toBe('Daily at 9:00 AM');
    expect(humanCron('30 14 * * *')).toBe('Daily at 2:30 PM');
    expect(humanCron('0 0 * * *')).toBe('Daily at 12:00 AM');
    expect(humanCron('0 12 * * *')).toBe('Daily at 12:00 PM');
    expect(humanCron('0 23 * * *')).toBe('Daily at 11:00 PM');
  });

  // Multiple hours daily
  it('handles multiple hours', () => {
    expect(humanCron('0 9,17 * * *')).toBe('Daily at 9:00 AM, 5:00 PM');
    expect(humanCron('30 8,12,18 * * *')).toBe('Daily at 8:30 AM, 12:30 PM, 6:30 PM');
  });

  // Weekday schedules
  it('handles weekday schedules', () => {
    expect(humanCron('0 9 * * 1-5')).toBe('Weekdays at 9:00 AM');
    expect(humanCron('0 9 * * MON-FRI')).toBe('Weekdays at 9:00 AM');
  });

  // Weekend schedules
  it('handles weekend schedules', () => {
    expect(humanCron('0 10 * * 0,6')).toBe('Weekends at 10:00 AM');
    expect(humanCron('0 10 * * SAT,SUN')).toBe('Weekends at 10:00 AM');
  });

  // Specific day of week
  it('handles specific day of week', () => {
    expect(humanCron('0 9 * * 1')).toBe('Mons at 9:00 AM');
    expect(humanCron('0 9 * * 5')).toBe('Fris at 9:00 AM');
  });

  // Hour range
  it('handles hour ranges', () => {
    expect(humanCron('0 9-17 * * *')).toBe('Hourly 9:00 AM - 5:00 PM');
    expect(humanCron('0 9-17 * * 1-5')).toBe('Weekdays hourly 9:00 AM - 5:00 PM');
  });

  // Monthly
  it('handles monthly schedules', () => {
    expect(humanCron('0 9 1 * *')).toBe('1st of every month at 9:00 AM');
    expect(humanCron('0 9 15 * *')).toBe('15th of every month at 9:00 AM');
    expect(humanCron('30 14 2 * *')).toBe('2nd of every month at 2:30 PM');
    expect(humanCron('0 9 3 * *')).toBe('3rd of every month at 9:00 AM');
    expect(humanCron('0 9 22 * *')).toBe('22nd of every month at 9:00 AM');
  });

  // Fallback for unrecognized patterns
  it('returns raw expression for unrecognized patterns', () => {
    expect(humanCron('0 9 1 6 1')).toBe('0 9 1 6 1');
  });
});

describe('ordinal formatting', () => {
  it('handles special ordinals correctly via monthly', () => {
    expect(humanCron('0 0 11 * *')).toBe('11th of every month at 12:00 AM');
    expect(humanCron('0 0 12 * *')).toBe('12th of every month at 12:00 AM');
    expect(humanCron('0 0 13 * *')).toBe('13th of every month at 12:00 AM');
    expect(humanCron('0 0 21 * *')).toBe('21st of every month at 12:00 AM');
    expect(humanCron('0 0 31 * *')).toBe('31st of every month at 12:00 AM');
  });
});
