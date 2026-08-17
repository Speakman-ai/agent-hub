import { describe, it, expect } from 'vitest';
import {
  HUB_UNAVAILABLE_DETAIL_MARKER,
  hubUnavailableDetail,
  detailIsHubUnavailable,
} from './hub-unavailable.js';
import { SPOT_RECLAIM_DETAIL_MARKER, spotReclaimDetail } from './spot-interruption.js';

describe('hub-unavailable detail marker', () => {
  it('prefixes the human message with the marker', () => {
    const d = hubUnavailableDetail('runner agent lost — 5 jobs reaped in one tick');
    expect(d.startsWith(HUB_UNAVAILABLE_DETAIL_MARKER)).toBe(true);
    expect(d).toContain('5 jobs reaped in one tick');
  });

  it('detects the marker on a wrapped detail', () => {
    expect(detailIsHubUnavailable(hubUnavailableDetail('anything'))).toBe(true);
  });

  it('returns false for plain, spot, null, and empty details', () => {
    expect(detailIsHubUnavailable('runner agent lost — lease expired with no heartbeat')).toBe(
      false,
    );
    expect(detailIsHubUnavailable(spotReclaimDetail('reclaimed'))).toBe(false);
    expect(detailIsHubUnavailable(null)).toBe(false);
    expect(detailIsHubUnavailable(undefined)).toBe(false);
    expect(detailIsHubUnavailable('')).toBe(false);
  });

  it('is a distinct marker from the spot-reclaim marker', () => {
    expect(HUB_UNAVAILABLE_DETAIL_MARKER).not.toBe(SPOT_RECLAIM_DETAIL_MARKER);
    // A spot detail must not read as a hub blip and vice-versa.
    expect(detailIsHubUnavailable(spotReclaimDetail('x'))).toBe(false);
  });
});
