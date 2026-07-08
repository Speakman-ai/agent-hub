import { describe, it, expect, vi } from 'vitest';
import {
  RRWEB_FULL_SNAPSHOT,
  computeSessionViews,
  streamSessionSegments,
  seekBaselineIndex,
  type SessionSegmentManifest,
} from './replayPlayer';

function twoViewManifest(): SessionSegmentManifest {
  return {
    sessionId: 'sess-1',
    storageLayout: 'segmented',
    segmentCount: 3,
    durationMs: 20_000,
    segments: [
      {
        segmentId: 'a0',
        viewId: 'viewA',
        indexInView: 0,
        hasFullSnapshot: true,
        startTs: 1000,
        endTs: 6000,
        eventCount: 2,
      },
      {
        segmentId: 'a1',
        viewId: 'viewA',
        indexInView: 1,
        hasFullSnapshot: false,
        startTs: 6000,
        endTs: 11000,
        eventCount: 2,
      },
      {
        segmentId: 'b0',
        viewId: 'viewB',
        indexInView: 0,
        hasFullSnapshot: true,
        startTs: 12000,
        endTs: 21000,
        eventCount: 2,
      },
    ],
  };
}

describe('computeSessionViews', () => {
  it('emits one chapter per view in playback order with ms offsets from session start', () => {
    const views = computeSessionViews(twoViewManifest());
    expect(views.map((v) => v.viewId)).toEqual(['viewA', 'viewB']);
    expect(views[0]).toMatchObject({ index: 0, offsetMs: 0, startTs: 1000 });
    // viewB's first segment starts 11s after the earliest segment (1000 → 12000).
    expect(views[1]).toMatchObject({ index: 1, offsetMs: 11000, startTs: 12000 });
  });

  it('collapses repeated view ids to their first occurrence', () => {
    expect(computeSessionViews(twoViewManifest())).toHaveLength(2);
  });

  it('returns [] for an empty or missing manifest', () => {
    expect(computeSessionViews({ sessionId: 's', segments: [] })).toEqual([]);
    expect(computeSessionViews(null)).toEqual([]);
    expect(computeSessionViews(undefined)).toEqual([]);
  });
});

describe('streamSessionSegments', () => {
  it('stitches every view segment in manifest order onto one timeline (multi-view stitch)', async () => {
    const manifest = twoViewManifest();
    const byId: Record<string, unknown[]> = {
      a0: [
        { type: 4, timestamp: 1000 },
        { type: RRWEB_FULL_SNAPSHOT, timestamp: 1000 },
      ],
      a1: [
        { type: 3, timestamp: 6000 },
        { type: 3, timestamp: 9000 },
      ],
      b0: [
        { type: 4, timestamp: 12000 },
        { type: RRWEB_FULL_SNAPSHOT, timestamp: 12000 },
      ],
    };
    const getManifest = vi.fn().mockResolvedValue(manifest);
    const getSegmentEvents = vi.fn((_sid: string, segId: string) =>
      Promise.resolve({ events: byId[segId] }),
    );
    const chunks: any[][] = [];
    const order: string[] = [];
    const result = await streamSessionSegments({
      getManifest,
      getSegmentEvents,
      sessionId: 'sess-1',
      onChunk: (events, seg) => {
        chunks.push(events as any[]);
        order.push(seg.segmentId);
      },
    });

    // Segments fetched + streamed in manifest (playback) order, view A before B.
    expect(order).toEqual(['a0', 'a1', 'b0']);
    // The stitched timeline is monotonic in timestamp across the view boundary.
    const stitched = chunks.flat() as Array<{ type: number; timestamp: number }>;
    const ts = stitched.map((e) => e.timestamp);
    expect(ts).toEqual([...ts].sort((x, y) => x - y));
    // Both views contribute a full snapshot so rrweb can rebuild at each boundary.
    expect(stitched.filter((e) => e.type === RRWEB_FULL_SNAPSHOT)).toHaveLength(2);
    expect(result.segmentCount).toBe(3);
    expect(result.eventCount).toBe(6);
    expect(result.durationMs).toBe(20_000);
  });

  it('reports the manifest via onManifest before streaming events', async () => {
    const seen: string[] = [];
    await streamSessionSegments({
      getManifest: vi.fn().mockResolvedValue(twoViewManifest()),
      getSegmentEvents: vi.fn((_s: string, id: string) => {
        seen.push(`ev:${id}`);
        return Promise.resolve({ events: [{ type: 3, timestamp: 1 }] });
      }),
      sessionId: 'sess-1',
      onManifest: () => seen.push('manifest'),
      onChunk: () => {},
    });
    expect(seen[0]).toBe('manifest');
    expect(seen.slice(1)).toEqual(['ev:a0', 'ev:a1', 'ev:b0']);
  });

  it('stops mid-session when the signal aborts', async () => {
    const controller = new AbortController();
    const getSegmentEvents = vi.fn((_s: string, id: string) => {
      // Abort after the first segment; the loop must not fetch the rest.
      if (id === 'a0') controller.abort();
      return Promise.resolve({ events: [{ type: 3, timestamp: 1 }] });
    });
    const result = await streamSessionSegments({
      getManifest: vi.fn().mockResolvedValue(twoViewManifest()),
      getSegmentEvents,
      sessionId: 'sess-1',
      onChunk: () => {},
      signal: controller.signal,
    });
    expect(getSegmentEvents).toHaveBeenCalledTimes(1);
    expect(result.eventCount).toBe(1);
  });

  it('tolerates a segment with no events', async () => {
    const result = await streamSessionSegments({
      getManifest: vi.fn().mockResolvedValue(twoViewManifest()),
      getSegmentEvents: vi.fn().mockResolvedValue({}),
      sessionId: 'sess-1',
      onChunk: () => {
        throw new Error('should not be called for an empty segment');
      },
    });
    expect(result.eventCount).toBe(0);
  });
});

describe('seekBaselineIndex (seek across a view boundary)', () => {
  // The stitched two-view timeline: viewA snapshot @1000, incrementals, then
  // viewB snapshot @12000, incremental @15000.
  const timeline = [
    { type: 4, timestamp: 1000 },
    { type: RRWEB_FULL_SNAPSHOT, timestamp: 1000 }, // idx 1 — viewA snapshot
    { type: 3, timestamp: 6000 },
    { type: 3, timestamp: 9000 },
    { type: 4, timestamp: 12000 },
    { type: RRWEB_FULL_SNAPSHOT, timestamp: 12000 }, // idx 5 — viewB snapshot
    { type: 3, timestamp: 15000 },
  ];

  it('rebuilds from viewA snapshot when seeking within viewA', () => {
    expect(seekBaselineIndex(timeline, 9000)).toBe(1);
  });

  it('rebuilds from viewB snapshot when seeking past the view boundary', () => {
    // Landing at/after viewB's start must pick viewB's snapshot, not viewA's.
    expect(seekBaselineIndex(timeline, 15000)).toBe(5);
    expect(seekBaselineIndex(timeline, 12000)).toBe(5);
  });

  it('returns -1 when no snapshot precedes the target', () => {
    expect(seekBaselineIndex(timeline, 500)).toBe(-1);
  });
});
