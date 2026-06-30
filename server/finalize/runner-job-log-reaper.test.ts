import { describe, expect, it, vi } from 'vitest';
import {
  RUNNER_JOB_LOG_REAPER_CRON,
  resolveRetentionMs,
  runRunnerJobLogReaper,
} from './runner-job-log-reaper.js';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

describe('resolveRetentionMs', () => {
  it('defaults to 1 day when the env var is unset', () => {
    expect(resolveRetentionMs({})).toBe(1 * MS_PER_DAY);
  });

  it('honors a positive numeric override', () => {
    expect(resolveRetentionMs({ FINALIZE_RUNNER_JOB_LOG_RETENTION_DAYS: '7' })).toBe(
      7 * MS_PER_DAY,
    );
  });

  it('honors a fractional override (e.g. 0.5 day)', () => {
    expect(resolveRetentionMs({ FINALIZE_RUNNER_JOB_LOG_RETENTION_DAYS: '0.5' })).toBe(
      0.5 * MS_PER_DAY,
    );
  });

  it.each(['0', '-5', 'abc', ''])(
    'falls back to the default for invalid value %j (never collapses retention to zero)',
    (raw) => {
      expect(resolveRetentionMs({ FINALIZE_RUNNER_JOB_LOG_RETENTION_DAYS: raw })).toBe(
        1 * MS_PER_DAY,
      );
    },
  );
});

describe('runRunnerJobLogReaper', () => {
  it('prunes with cutoff = now - retentionMs and returns the deleted count', () => {
    const prune = vi.fn().mockReturnValue(4);
    const deleted = runRunnerJobLogReaper({
      now: () => 1_000_000,
      retentionMs: 10_000,
      prune,
      log: () => {},
    });
    expect(deleted).toBe(4);
    expect(prune).toHaveBeenCalledWith({ cutoff: 990_000 });
  });

  it('logs only when rows were actually pruned', () => {
    const log = vi.fn();
    runRunnerJobLogReaper({ now: () => 0, retentionMs: 1, prune: () => 0, log });
    expect(log).not.toHaveBeenCalled();
    runRunnerJobLogReaper({ now: () => 0, retentionMs: 1, prune: () => 2, log });
    expect(log).toHaveBeenCalledOnce();
  });

  it('runs every 5 minutes', () => {
    expect(RUNNER_JOB_LOG_REAPER_CRON).toBe('*/5 * * * *');
  });
});
