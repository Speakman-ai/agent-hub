import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  checkSpotInterruption,
  detailIsSpotReclaim,
  parseInstanceActionBody,
  spotReclaimDetail,
  SPOT_RECLAIM_DETAIL_MARKER,
  type FetchLike,
} from './spot-interruption.js';

/** Minimal fetch-response stub. */
function resp(
  status: number,
  body = '',
): {
  ok: boolean;
  status: number;
  text: () => Promise<string>;
} {
  return { ok: status >= 200 && status < 300, status, text: async () => body };
}

describe('spot-interruption detail marker', () => {
  it('round-trips the marker through spotReclaimDetail / detailIsSpotReclaim', () => {
    const detail = spotReclaimDetail('runner lost — spot reclaim');
    expect(detail.startsWith(SPOT_RECLAIM_DETAIL_MARKER)).toBe(true);
    expect(detailIsSpotReclaim(detail)).toBe(true);
  });

  it('does not match generic infra detail', () => {
    expect(detailIsSpotReclaim('runner agent lost — lease expired with no heartbeat')).toBe(false);
    expect(detailIsSpotReclaim(null)).toBe(false);
    expect(detailIsSpotReclaim(undefined)).toBe(false);
    expect(detailIsSpotReclaim('')).toBe(false);
  });
});

describe('parseInstanceActionBody', () => {
  it('flags a pending terminate notice', () => {
    const s = parseInstanceActionBody('{"action":"terminate","time":"2026-06-23T02:30:00Z"}');
    expect(s.pending).toBe(true);
    expect(s.action).toBe('terminate');
    expect(s.time).toBe('2026-06-23T02:30:00Z');
  });

  it.each(['stop', 'hibernate'])('flags a pending %s notice', (action) => {
    expect(parseInstanceActionBody(`{"action":"${action}"}`).pending).toBe(true);
  });

  it('returns not-pending for empty / unparseable / unknown-action bodies', () => {
    expect(parseInstanceActionBody('').pending).toBe(false);
    expect(parseInstanceActionBody('not json').pending).toBe(false);
    expect(parseInstanceActionBody('{"action":"reboot"}').pending).toBe(false);
    expect(parseInstanceActionBody('{}').pending).toBe(false);
  });
});

describe('checkSpotInterruption', () => {
  const ORIGINAL_ENV = { ...process.env };
  beforeEach(() => {
    delete process.env.AWS_EC2_METADATA_DISABLED;
    delete process.env.AWS_EC2_METADATA_SERVICE_ENDPOINT;
  });
  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    vi.restoreAllMocks();
  });

  it('detects a pending interruption via IMDSv2 (token then action)', async () => {
    const calls: string[] = [];
    const fetchImpl: FetchLike = vi.fn(async (url, init) => {
      calls.push(`${init?.method} ${url}`);
      if (url.endsWith('/latest/api/token')) return resp(200, 'TOKEN123');
      if (url.endsWith('/latest/meta-data/spot/instance-action')) {
        // The action GET must carry the token header.
        expect(init?.headers?.['x-aws-ec2-metadata-token']).toBe('TOKEN123');
        return resp(200, '{"action":"terminate","time":"2026-06-23T02:30:00Z"}');
      }
      throw new Error(`unexpected url ${url}`);
    });

    const status = await checkSpotInterruption({ fetchImpl });
    expect(status.pending).toBe(true);
    expect(status.action).toBe('terminate');
    expect(calls[0]).toBe('PUT http://169.254.169.254/latest/api/token');
    expect(calls[1]).toBe('GET http://169.254.169.254/latest/meta-data/spot/instance-action');
  });

  it('returns not-pending when IMDS answers 404 (steady state)', async () => {
    const fetchImpl: FetchLike = vi.fn(async (url) => {
      if (url.endsWith('/latest/api/token')) return resp(200, 'TOKEN123');
      return resp(404, 'not found');
    });
    expect((await checkSpotInterruption({ fetchImpl })).pending).toBe(false);
  });

  it('returns not-pending (no throw) when off-EC2 and fetch rejects', async () => {
    const fetchImpl: FetchLike = vi.fn(async () => {
      throw new Error('connect ECONNREFUSED 169.254.169.254:80');
    });
    const status = await checkSpotInterruption({ fetchImpl });
    expect(status.pending).toBe(false);
  });

  it('returns not-pending when the token fetch fails (no IMDSv1 fallback)', async () => {
    const fetchImpl: FetchLike = vi.fn(async (url) => {
      if (url.endsWith('/latest/api/token')) return resp(403, '');
      throw new Error('should not reach the action endpoint without a token');
    });
    expect((await checkSpotInterruption({ fetchImpl })).pending).toBe(false);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('short-circuits (no fetch) when AWS_EC2_METADATA_DISABLED is set', async () => {
    process.env.AWS_EC2_METADATA_DISABLED = 'true';
    const fetchImpl: FetchLike = vi.fn(async () => resp(200, 'TOKEN'));
    expect((await checkSpotInterruption({ fetchImpl })).pending).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('honors AWS_EC2_METADATA_SERVICE_ENDPOINT override', async () => {
    process.env.AWS_EC2_METADATA_SERVICE_ENDPOINT = 'http://imds.test:1234/';
    const seen: string[] = [];
    const fetchImpl: FetchLike = vi.fn(async (url) => {
      seen.push(url);
      if (url.endsWith('/latest/api/token')) return resp(200, 'T');
      return resp(200, '{"action":"terminate"}');
    });
    const status = await checkSpotInterruption({ fetchImpl });
    expect(status.pending).toBe(true);
    expect(seen[0]).toBe('http://imds.test:1234/latest/api/token');
  });
});
