import { describe, expect, it } from 'vitest';
import { parseAgentBringupTimings, timePhase } from './job-startup.js';

describe('parseAgentBringupTimings', () => {
  it('keeps known phases with sane millisecond values', () => {
    expect(
      parseAgentBringupTimings({
        clear_workspace: 12.4,
        materialize: 4_000,
        chown: 0,
        container_start: 9_999,
      }),
    ).toEqual({ clear_workspace: 12, materialize: 4_000, chown: 0, container_start: 9_999 });
  });

  it('drops unknown keys, negatives, non-numbers and day-plus values', () => {
    expect(
      parseAgentBringupTimings({
        materialize: 1_500,
        chown: -1,
        container_start: '30',
        clear_workspace: 25 * 60 * 60 * 1000,
        queue_wait: 10,
      }),
    ).toEqual({ materialize: 1_500 });
  });

  it('returns null when nothing usable was sent', () => {
    expect(parseAgentBringupTimings(null)).toBeNull();
    expect(parseAgentBringupTimings('fast')).toBeNull();
    expect(parseAgentBringupTimings({ chown: Infinity })).toBeNull();
  });
});

describe('timePhase', () => {
  it('records the elapsed time even when the phase throws', async () => {
    let clock = 0;
    const now = () => clock;
    const timings: Record<string, number> = {};
    await timePhase(
      timings,
      'materialize',
      async () => {
        clock += 300;
      },
      now,
    );
    await expect(
      timePhase(
        timings,
        'chown',
        async () => {
          clock += 50;
          throw new Error('EACCES');
        },
        now,
      ),
    ).rejects.toThrow('EACCES');
    expect(timings).toEqual({ materialize: 300, chown: 50 });
  });
});
