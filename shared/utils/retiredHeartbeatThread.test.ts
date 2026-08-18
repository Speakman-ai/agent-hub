import { describe, it, expect } from 'vitest';
import {
  excludeRetiredHeartbeatThreads,
  isRetiredHeartbeatThread,
} from './retiredHeartbeatThread.js';

describe('isRetiredHeartbeatThread', () => {
  it('is true only for type=heartbeat', () => {
    expect(isRetiredHeartbeatThread({ type: 'heartbeat' })).toBe(true);
    expect(isRetiredHeartbeatThread({ type: 'cron' })).toBe(false);
    expect(isRetiredHeartbeatThread({ type: 'other' })).toBe(false);
    expect(isRetiredHeartbeatThread({})).toBe(false);
    expect(isRetiredHeartbeatThread(null)).toBe(false);
    expect(isRetiredHeartbeatThread(undefined)).toBe(false);
  });
});

describe('excludeRetiredHeartbeatThreads', () => {
  it('drops heartbeat rows and keeps cron / unknown types', () => {
    expect(
      excludeRetiredHeartbeatThreads([
        { id: 'h', type: 'heartbeat' },
        { id: 'c', type: 'cron' },
        { id: 'x' },
      ]),
    ).toEqual([{ id: 'c', type: 'cron' }, { id: 'x' }]);
  });

  it('returns [] for non-arrays', () => {
    expect(excludeRetiredHeartbeatThreads(null)).toEqual([]);
    expect(excludeRetiredHeartbeatThreads(undefined)).toEqual([]);
  });
});
