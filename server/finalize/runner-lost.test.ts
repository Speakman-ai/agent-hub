import { describe, it, expect } from 'vitest';
import { RUNNER_LOST_DETAIL_MARKER, runnerLostDetail, detailIsRunnerLost } from './runner-lost.js';
import { HUB_UNAVAILABLE_DETAIL_MARKER, hubUnavailableDetail } from './hub-unavailable.js';
import { SPOT_RECLAIM_DETAIL_MARKER, spotReclaimDetail } from './spot-interruption.js';

describe('runner-lost detail marker', () => {
  it('prefixes the human message with the marker', () => {
    const d = runnerLostDetail('runner agent lost — lease expired with no heartbeat');
    expect(d.startsWith(RUNNER_LOST_DETAIL_MARKER)).toBe(true);
    expect(d).toContain('lease expired with no heartbeat');
  });

  it('detects the marker on a wrapped detail', () => {
    expect(detailIsRunnerLost(runnerLostDetail('anything'))).toBe(true);
  });

  it('returns false for plain, spot, hub, null, and empty details', () => {
    expect(detailIsRunnerLost('runner agent lost — lease expired with no heartbeat')).toBe(false);
    expect(detailIsRunnerLost(spotReclaimDetail('reclaimed'))).toBe(false);
    expect(detailIsRunnerLost(hubUnavailableDetail('hub blip'))).toBe(false);
    expect(detailIsRunnerLost(null)).toBe(false);
    expect(detailIsRunnerLost(undefined)).toBe(false);
    expect(detailIsRunnerLost('')).toBe(false);
  });

  it('is a distinct marker from spot-reclaim and hub-unavailable', () => {
    expect(RUNNER_LOST_DETAIL_MARKER).not.toBe(SPOT_RECLAIM_DETAIL_MARKER);
    expect(RUNNER_LOST_DETAIL_MARKER).not.toBe(HUB_UNAVAILABLE_DETAIL_MARKER);
    expect(detailIsRunnerLost(spotReclaimDetail('x'))).toBe(false);
    expect(detailIsRunnerLost(hubUnavailableDetail('x'))).toBe(false);
  });
});
