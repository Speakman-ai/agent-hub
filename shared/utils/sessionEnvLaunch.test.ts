import { describe, expect, it } from 'vitest';
import {
  SESSION_ENV_LAUNCH_STEP,
  latestSessionEnvLaunch,
  latestSessionEnvLaunchStatus,
} from './sessionEnvLaunch.js';

describe('latestSessionEnvLaunch', () => {
  it('returns null when there is no VM launch step', () => {
    expect(latestSessionEnvLaunch(undefined)).toBeNull();
    expect(latestSessionEnvLaunch([])).toBeNull();
    expect(
      latestSessionEnvLaunch([
        { event: { type: 'progress_step', step: 'Gather', status: 'started' } },
      ]),
    ).toBeNull();
  });

  it('returns the latest status for the VM launch step', () => {
    const startedAt = 1;
    expect(
      latestSessionEnvLaunch([
        {
          event: {
            type: 'progress_step',
            step: SESSION_ENV_LAUNCH_STEP,
            status: 'started',
            startedAt,
          },
        },
      ]),
    ).toEqual({ status: 'started', startedAt });
    expect(
      latestSessionEnvLaunchStatus([
        {
          event: {
            type: 'progress_step',
            step: SESSION_ENV_LAUNCH_STEP,
            status: 'started',
            startedAt,
          },
        },
        {
          event: {
            type: 'progress_step',
            step: SESSION_ENV_LAUNCH_STEP,
            status: 'completed',
            startedAt,
            finishedAt: 2,
          },
        },
      ]),
    ).toBe('completed');
  });
});
