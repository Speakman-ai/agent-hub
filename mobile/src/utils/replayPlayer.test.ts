import { describe, it, expect, vi } from 'vitest';
import {
  RRWEB_FULL_SNAPSHOT,
  REPLAY_CHANNEL,
  PLAYER_CSP,
  WEBVIEW_BOOTSTRAP,
  computeSessionViews,
  streamSessionSegments,
  seekBaselineIndex,
  escapeForScript,
  buildReplayPlayerSrcDoc,
  buildReplayPlayerDataUrl,
  buildInjectedReceive,
  replayTargetKey,
  streamReplayEvents,
  streamReplayTarget,
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

describe('escapeForScript', () => {
  it('neutralizes a literal </script so an inlined bundle cannot break out', () => {
    expect(escapeForScript('a</script>b')).toBe('a<\\/script>b');
  });
  it('is case-insensitive (matches any-case </script, replacement is fixed)', () => {
    expect(escapeForScript('x</SCRIPT y')).toBe('x<\\/script y');
  });
});

describe('WEBVIEW_BOOTSTRAP', () => {
  it('is valid JavaScript (no stray TypeScript syntax that would stall playback)', () => {
    // A `: any` or other TS token here makes the inlined script a SyntaxError and
    // the frame never wires its receive handler — guard it at unit speed.
    expect(() => new Function(WEBVIEW_BOOTSTRAP)).not.toThrow();
  });
  it('bridges via ReactNativeWebView.postMessage and exposes __ahReplayReceive', () => {
    expect(WEBVIEW_BOOTSTRAP).toContain('window.ReactNativeWebView');
    expect(WEBVIEW_BOOTSTRAP).toContain('window.__ahReplayReceive');
    expect(WEBVIEW_BOOTSTRAP).toContain('rrwebPlayer');
    // Handles the same message vocabulary as the web iframe bootstrap.
    for (const t of ['chunk', 'end', 'goto', 'error', 'ready', 'playing']) {
      expect(WEBVIEW_BOOTSTRAP).toContain(t);
    }
  });
});

describe('buildReplayPlayerSrcDoc / DataUrl (opaque-origin no-network island)', () => {
  it('inlines the player js + css and the WebView bootstrap under a locked-down CSP', () => {
    const doc = buildReplayPlayerSrcDoc('/*JS*/window.rrwebPlayer={};', '.rr-player{}');
    expect(doc).toContain(PLAYER_CSP);
    expect(doc).toContain('window.rrwebPlayer={}');
    expect(doc).toContain('.rr-player{}');
    expect(doc).toContain('__ahReplayReceive');
    // No-network invariants carried from web.
    expect(PLAYER_CSP).toContain("connect-src 'none'");
    expect(PLAYER_CSP).toContain("default-src 'none'");
  });
  it('escapes a </script> in the injected bundle so it cannot close the tag early', () => {
    const doc = buildReplayPlayerSrcDoc('var s="</script>";', '');
    expect(doc).not.toContain('"</script>"');
    expect(doc).toContain('<\\/script>');
  });
  it('wraps the doc in a data:text/html URL (opaque origin, not srcDoc)', () => {
    const url = buildReplayPlayerDataUrl('window.rrwebPlayer={};', '');
    expect(url.startsWith('data:text/html;charset=utf-8,')).toBe(true);
    expect(decodeURIComponent(url.slice('data:text/html;charset=utf-8,'.length))).toContain(
      '<!doctype html>',
    );
  });
});

describe('buildInjectedReceive (RN → WebView transport)', () => {
  it('builds a self-terminating injectJavaScript payload carrying the channel tag', () => {
    const code = buildInjectedReceive({ type: 'goto', offsetMs: 4200 });
    expect(code).toContain('window.__ahReplayReceive(');
    expect(code.trim().endsWith('true;')).toBe(true);
    const json = code.slice(code.indexOf('(') + 1, code.lastIndexOf(')'));
    expect(JSON.parse(json)).toEqual({ ch: REPLAY_CHANNEL, type: 'goto', offsetMs: 4200 });
  });
  it('serializes event chunks so the frame can concat them', () => {
    const events = [{ type: 3, timestamp: 1 }];
    const code = buildInjectedReceive({ type: 'chunk', events });
    const json = code.slice(code.indexOf('(') + 1, code.lastIndexOf(')'));
    expect(JSON.parse(json)).toEqual({ ch: REPLAY_CHANNEL, type: 'chunk', events });
  });
});

describe('streamReplayEvents (monolithic pagination)', () => {
  it('walks pages until hasMore=false and returns the reported total', async () => {
    const pages = [
      { events: [{ t: 1 }, { t: 2 }], total: 3, hasMore: true },
      { events: [{ t: 3 }], total: 3, hasMore: false },
    ];
    const getEvents = vi.fn((_id: string, offset: number) =>
      Promise.resolve(offset === 0 ? pages[0] : pages[1]),
    );
    const chunks: unknown[][] = [];
    const total = await streamReplayEvents({
      getEvents,
      replayId: 'r1',
      pageSize: 2,
      onChunk: (events) => chunks.push(events),
    });
    expect(getEvents).toHaveBeenCalledTimes(2);
    expect(getEvents.mock.calls[1][1]).toBe(2); // second page offset = first page length
    expect(chunks.flat()).toHaveLength(3);
    expect(total).toBe(3);
  });
  it('stops when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const getEvents = vi.fn();
    const total = await streamReplayEvents({
      getEvents,
      replayId: 'r1',
      signal: controller.signal,
    });
    expect(getEvents).not.toHaveBeenCalled();
    expect(total).toBe(0);
  });
});

describe('replayTargetKey (WebView remount identity)', () => {
  it('prefixes by mode so a session and a monolithic capture never collide', () => {
    // The WebView is keyed by this; a collision would reuse the already-handshook
    // frame and leave the new target stuck on "Loading player…".
    expect(replayTargetKey({ mode: 'session', sessionId: 'x' })).toBe('session:x');
    expect(replayTargetKey({ mode: 'replay', replayId: 'x' })).toBe('replay:x');
    expect(replayTargetKey({ sessionId: 'x' })).not.toBe(replayTargetKey({ replayId: 'x' }));
  });

  it('changes when the target changes so the frame remounts + re-streams', () => {
    expect(replayTargetKey({ sessionId: 's-1' })).not.toBe(replayTargetKey({ sessionId: 's-2' }));
    expect(replayTargetKey({ replayId: 'r-1' })).not.toBe(replayTargetKey({ replayId: 'r-2' }));
  });

  it('is stable for the same target (frame is NOT remounted mid-stream)', () => {
    expect(replayTargetKey({ mode: 'session', sessionId: 's-1' })).toBe(
      replayTargetKey({ mode: 'session', sessionId: 's-1' }),
    );
  });

  it('matches streamReplayTarget precedence: replayId wins when both are set', () => {
    // streamReplayTarget treats a target with a replayId as monolithic mode; the
    // key must agree so keying and the stream path never disagree.
    expect(replayTargetKey({ sessionId: 's', replayId: 'r' })).toBe('replay:r');
  });

  it('returns empty for a null / empty target', () => {
    expect(replayTargetKey(null)).toBe('');
    expect(replayTargetKey(undefined)).toBe('');
    expect(replayTargetKey({})).toBe('');
  });
});

describe('streamReplayTarget (host → frame orchestration)', () => {
  function segmentedApi() {
    return {
      getSessionSegments: vi.fn().mockResolvedValue(twoViewManifest()),
      getSessionSegmentEvents: vi.fn((_s: string, _segId: string) =>
        Promise.resolve({
          events: [
            { type: 4, timestamp: 1 },
            { type: RRWEB_FULL_SNAPSHOT, timestamp: 2 },
          ],
          eventCount: 2,
        }),
      ),
      getReplay: vi.fn(),
      getReplayEvents: vi.fn(),
    };
  }

  it('session mode: streams every segment as a chunk, ends, and reports view chapters', async () => {
    const api = segmentedApi();
    const posts: any[] = [];
    const views: any[] = [];
    const progress: any[] = [];
    const count = await streamReplayTarget({
      target: { mode: 'session', sessionId: 'sess-1' },
      api: api as any,
      post: (m) => posts.push(m),
      onViews: (v) => views.push(v),
      onProgress: (p) => progress.push(p),
    });
    const chunkPosts = posts.filter((p) => p.type === 'chunk');
    expect(chunkPosts).toHaveLength(3); // one per segment (a0,a1,b0)
    expect(posts[posts.length - 1]).toEqual({ type: 'end' });
    expect(views[0].map((v: any) => v.viewId)).toEqual(['viewA', 'viewB']);
    expect(count).toBe(6);
    expect(progress[progress.length - 1]).toEqual({ loaded: 6, total: 6 });
    expect(api.getReplayEvents).not.toHaveBeenCalled();
  });

  it('monolithic mode: walks the events endpoint, chunks, and ends', async () => {
    const api = {
      getSessionSegments: vi.fn(),
      getSessionSegmentEvents: vi.fn(),
      getReplay: vi.fn().mockResolvedValue({ defaultPageSize: 2, eventCount: 3 }),
      getReplayEvents: vi.fn((_id: string, offset: number) =>
        Promise.resolve(
          offset === 0
            ? { events: [{ t: 1 }, { t: 2 }], total: 3, hasMore: true }
            : { events: [{ t: 3 }], total: 3, hasMore: false },
        ),
      ),
    };
    const posts: any[] = [];
    const count = await streamReplayTarget({
      target: { mode: 'replay', replayId: 'r1' },
      api: api as any,
      post: (m) => posts.push(m),
    });
    expect(api.getReplay).toHaveBeenCalledWith('r1');
    expect(api.getReplayEvents).toHaveBeenCalledTimes(2);
    expect(posts.filter((p) => p.type === 'chunk').flatMap((p) => p.events)).toHaveLength(3);
    expect(posts[posts.length - 1]).toEqual({ type: 'end' });
    expect(count).toBe(3);
    expect(api.getSessionSegments).not.toHaveBeenCalled();
  });

  it('monolithic mode tolerates missing metadata (getReplay throws)', async () => {
    const api = {
      getSessionSegments: vi.fn(),
      getSessionSegmentEvents: vi.fn(),
      getReplay: vi.fn().mockRejectedValue(new Error('no meta')),
      getReplayEvents: vi
        .fn()
        .mockResolvedValue({ events: [{ t: 1 }], total: 1, hasMore: false }),
    };
    const posts: any[] = [];
    const count = await streamReplayTarget({
      target: { mode: 'replay', replayId: 'r1' },
      api: api as any,
      post: (m) => posts.push(m),
    });
    expect(count).toBe(1);
    expect(posts[posts.length - 1]).toEqual({ type: 'end' });
  });
});
