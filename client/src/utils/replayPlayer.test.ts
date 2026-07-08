import { describe, it, expect, vi } from 'vitest';
import {
  REPLAY_CHANNEL,
  PLAYER_CSP,
  IFRAME_BOOTSTRAP,
  parseReplayIdFromRef,
  escapeForScript,
  buildReplayPlayerSrcDoc,
  buildReplayPlayerDataUrl,
  streamReplayEvents,
  computeSessionViews,
  streamSessionSegments,
  seekBaselineIndex,
  RRWEB_FULL_SNAPSHOT,
} from './replayPlayer';

describe('parseReplayIdFromRef', () => {
  it('extracts the id from a canonical /uploads/replay-<id>.json ref', () => {
    expect(parseReplayIdFromRef('/uploads/replay-abc123.json')).toBe('abc123');
  });

  it('handles uuid-shaped ids with dashes', () => {
    const id = '0cf52f09-cfd1-4205-b254-6af3fb1221d4';
    expect(parseReplayIdFromRef(`/uploads/replay-${id}.json`)).toBe(id);
  });

  it('tolerates a trailing query string', () => {
    expect(parseReplayIdFromRef('/uploads/replay-xyz.json?v=2')).toBe('xyz');
  });

  it('returns null for non-replay refs and bad input', () => {
    expect(parseReplayIdFromRef('/uploads/screenshot-1.png')).toBeNull();
    expect(parseReplayIdFromRef('')).toBeNull();
    expect(parseReplayIdFromRef(null)).toBeNull();
    expect(parseReplayIdFromRef(undefined)).toBeNull();
    expect(parseReplayIdFromRef(42)).toBeNull();
  });
});

describe('escapeForScript', () => {
  it('neutralizes a literal closing script tag so it cannot break out of <script>', () => {
    const out = escapeForScript('a</script>b');
    expect(out!).not.toContain('</script');
    expect(out!).toContain('<\\/script');
  });

  it('is case-insensitive on the tag', () => {
    expect(escapeForScript('x</SCRIPT>y')).not.toMatch(/<\/script/i);
  });
});

describe('buildReplayPlayerSrcDoc', () => {
  it('inlines the player bundle, the css, the bootstrap, and a #root mount', () => {
    const html = buildReplayPlayerSrcDoc('PLAYER_BUNDLE_JS', '.rr-player{color:red}');
    expect(html!).toContain('PLAYER_BUNDLE_JS');
    expect(html!).toContain('.rr-player{color:red}');
    expect(html!).toContain('id="root"');
    // The bootstrap wires the postMessage channel.
    expect(html!).toContain(REPLAY_CHANNEL);
    expect(html!).toContain('rrwebPlayer');
  });

  it('embeds a restrictive no-network CSP meta tag in the document head', () => {
    const html = buildReplayPlayerSrcDoc('PLAYER', 'css');
    // The CSP meta must appear in <head> so it governs every subresource.
    expect(html!).toContain(
      `<meta http-equiv="Content-Security-Policy" content="${PLAYER_CSP}" />`,
    );
    const headEnd = html.indexOf('</head>');
    expect(html.indexOf('Content-Security-Policy')).toBeLessThan(headEnd);
  });

  it('CSP denies by default and blocks network egress while allowing inline player code', () => {
    // default-src 'none' is the backstop; connect-src 'none' blocks
    // fetch/XHR/WebSocket/beacon — the actual exfiltration vector.
    expect(PLAYER_CSP!).toContain("default-src 'none'");
    expect(PLAYER_CSP!).toContain("connect-src 'none'");
    // Remote images/fonts/media are blocked (data:/blob: only — no http(s)).
    expect(PLAYER_CSP!).toMatch(/img-src data: blob:/);
    expect(PLAYER_CSP!).not.toMatch(/https?:/);
    // Inline player bundle + styles must still run (no remote, no eval).
    expect(PLAYER_CSP!).toContain("script-src 'unsafe-inline'");
    expect(PLAYER_CSP!).toContain("style-src 'unsafe-inline'");
    expect(PLAYER_CSP!).not.toContain('unsafe-eval');
  });

  it('CSP permits rrweb’s internal replay frame but blocks remote frames', () => {
    // rrweb renders into an iframe it createElement()s (initial about:blank), so
    // 'none' would refuse the replay surface. 'self' blob: data: allow the
    // internal mechanism; no http(s) source is whitelisted, so a replayed
    // <iframe src="https://…"> still can't load (remote frames blocked).
    expect(PLAYER_CSP!).toMatch(/frame-src 'self' blob: data:/);
    expect(PLAYER_CSP!).toMatch(/child-src 'self' blob: data:/);
    expect(PLAYER_CSP!).not.toMatch(/frame-src[^;]*https?:/);
  });

  it('inlines a bootstrap that is valid JavaScript (no leaked TS syntax)', () => {
    // The bootstrap is shipped as raw JS into a sandboxed <script> — it is never
    // transpiled. A JS->TS migration once leaked `: any` annotations into it,
    // which made the inline script a SyntaxError: the browser silently dropped
    // it, the message listener never registered, and the player never rendered
    // (stuck "Streaming events …" spinner). `new Function` parses the body
    // without executing it, so it fails loudly on any non-JS syntax.
    expect(() => new Function(IFRAME_BOOTSTRAP)).not.toThrow();
    // Guard the specific regression: no `: any`-style param/catch annotations.
    expect(IFRAME_BOOTSTRAP).not.toMatch(/\)\s*:\s*\w/);
    expect(IFRAME_BOOTSTRAP).not.toMatch(/\(\s*\w+\s*:\s*\w/);
    expect(IFRAME_BOOTSTRAP).not.toMatch(/catch\s*\(\s*\w+\s*:/);
  });

  it('re-announces readiness until acknowledged (resilient handshake)', () => {
    const html = buildReplayPlayerSrcDoc('PLAYER', 'css');
    // Belt-and-suspenders against a dropped initial 'ready': the sandbox retries
    // on an interval until the parent's first message flips `acked`.
    expect(html!).toContain("post({ type: 'ready' })");
    expect(html!).toContain('setInterval');
    expect(html!).toContain('acked');
  });

  it('sizes the replay frame so rrweb-player controls remain visible', () => {
    type ReplayFrameMessageListener = (event: { source: unknown; data: unknown }) => void;
    let onMessage: ReplayFrameMessageListener | undefined;
    let playerOptions: any = null;
    const parent = {
      postMessage: vi.fn(),
    };
    const windowStub = {
      innerWidth: 900,
      innerHeight: 600,
      parent,
      rrwebPlayer: function FakePlayer(options: any) {
        playerOptions = options;
      },
      addEventListener: vi.fn((event: string, listener: ReplayFrameMessageListener) => {
        if (event === 'message') onMessage = listener;
      }),
    };
    const documentStub = {
      getElementById: vi.fn(() => ({ innerHTML: 'loading' })),
    };

    const runBootstrap = new Function(
      'window',
      'document',
      'parent',
      'setInterval',
      'clearInterval',
      IFRAME_BOOTSTRAP,
    );
    runBootstrap(windowStub, documentStub, parent, vi.fn(), vi.fn());

    expect(onMessage).toBeDefined();
    const sendMessage = onMessage!;
    sendMessage({
      source: parent,
      data: { ch: REPLAY_CHANNEL, type: 'chunk', events: [{ type: 2, timestamp: 1 }] },
    });
    sendMessage({ source: parent, data: { ch: REPLAY_CHANNEL, type: 'end' } });

    expect(playerOptions?.props?.width).toBe(876);
    expect(playerOptions?.props?.height).toBe(496);
    expect(playerOptions?.props?.showController).toBe(true);
    expect(playerOptions?.props?.height + 80 + 24).toBe(600);
  });

  it('seeks the built player on a goto message (cross-view chapter jump)', () => {
    type ReplayFrameMessageListener = (event: { source: unknown; data: unknown }) => void;
    let onMessage: ReplayFrameMessageListener | undefined;
    const gotoCalls: number[] = [];
    const parent = { postMessage: vi.fn() };
    const windowStub = {
      innerWidth: 900,
      innerHeight: 600,
      parent,
      rrwebPlayer: function FakePlayer(this: any) {
        this.goto = (off: number) => gotoCalls.push(off);
      },
      addEventListener: vi.fn((event: string, listener: ReplayFrameMessageListener) => {
        if (event === 'message') onMessage = listener;
      }),
    };
    const documentStub = { getElementById: vi.fn(() => ({ innerHTML: 'loading' })) };
    const runBootstrap = new Function(
      'window',
      'document',
      'parent',
      'setInterval',
      'clearInterval',
      IFRAME_BOOTSTRAP,
    );
    runBootstrap(windowStub, documentStub, parent, vi.fn(), vi.fn());

    const send = onMessage!;
    // Build the player, then seek to a view offset on the stitched timeline.
    send({
      source: parent,
      data: { ch: REPLAY_CHANNEL, type: 'chunk', events: [{ type: 2, timestamp: 1 }] },
    });
    send({ source: parent, data: { ch: REPLAY_CHANNEL, type: 'end' } });
    send({ source: parent, data: { ch: REPLAY_CHANNEL, type: 'goto', offsetMs: 4200 } });

    expect(gotoCalls).toEqual([4200]);
    // A non-numeric offset is ignored (no throw, no spurious seek).
    send({ source: parent, data: { ch: REPLAY_CHANNEL, type: 'goto', offsetMs: 'nope' } });
    expect(gotoCalls).toEqual([4200]);
  });

  it('escapes a closing script tag hidden in the bundle string', () => {
    const html = buildReplayPlayerSrcDoc('evil</script><img>', 'css');
    // The raw breakout sequence must not survive into the document.
    expect(html!).not.toContain('evil</script>');
    expect(html!).toContain('evil<\\/script');
  });

  it('does not throw on empty inputs', () => {
    expect(() => buildReplayPlayerSrcDoc('', '')).not.toThrow();
    expect(() => buildReplayPlayerSrcDoc(undefined, undefined)).not.toThrow();
  });
});

describe('buildReplayPlayerDataUrl', () => {
  it('wraps the player document in a data:text/html URL (isolated opaque origin)', () => {
    const url = buildReplayPlayerDataUrl('PLAYER_BUNDLE_JS', '.rr-player{color:red}');
    // A data: URL is what makes the frame cross-origin to the host app; a
    // srcDoc / blob: URL would inherit the host origin and break isolation.
    expect(url.startsWith('data:text/html;charset=utf-8,')).toBe(true);
  });

  it('round-trips to the same HTML buildReplayPlayerSrcDoc produces', () => {
    const html = buildReplayPlayerSrcDoc('PLAYER', '.x{color:red}');
    const url = buildReplayPlayerDataUrl('PLAYER', '.x{color:red}');
    const decoded = decodeURIComponent(url.replace(/^data:text\/html;charset=utf-8,/, ''));
    expect(decoded).toBe(html);
    expect(decoded).toContain("connect-src 'none'");
  });

  it('percent-encodes so the markup cannot break out of the URL', () => {
    const url = buildReplayPlayerDataUrl('PLAYER', 'css');
    // Raw angle brackets / quotes must be encoded, not literal, in the URL.
    expect(url).not.toContain('<script');
    expect(url).toContain('%3Cscript');
  });

  it('does not throw on empty inputs', () => {
    expect(() => buildReplayPlayerDataUrl('', '')).not.toThrow();
    expect(() => buildReplayPlayerDataUrl(undefined, undefined)).not.toThrow();
  });
});

describe('streamReplayEvents', () => {
  it('walks every page and reports each non-empty chunk', async () => {
    const pages = [
      { events: [{ t: 1 }, { t: 2 }], total: 5, offset: 0, hasMore: true },
      { events: [{ t: 3 }, { t: 4 }], total: 5, offset: 2, hasMore: true },
      { events: [{ t: 5 }], total: 5, offset: 4, hasMore: false },
    ];
    const getEvents = vi.fn((_id: any, offset: any) => {
      // Map the requested offset back to the page index (pages are size 2).
      const idx = offset === 0 ? 0 : offset === 2 ? 1 : 2;
      return Promise.resolve(pages[idx]);
    });
    const chunks: any[] = [];
    const total = await streamReplayEvents({
      getEvents,
      replayId: 'r1',
      pageSize: 2,
      onChunk: (events: any) => chunks.push(events),
    });

    expect(getEvents!).toHaveBeenCalledTimes(3);
    expect(chunks.flat()).toHaveLength(5);
    expect(total!).toBe(5);
  });

  it('stops when hasMore is false even if events remain', async () => {
    const getEvents = vi.fn().mockResolvedValue({
      events: [{ t: 1 }],
      total: 1,
      offset: 0,
      hasMore: false,
    });
    const onChunk = vi.fn();
    await streamReplayEvents({ getEvents, replayId: 'r', pageSize: 10, onChunk });
    expect(getEvents!).toHaveBeenCalledTimes(1);
    expect(onChunk!).toHaveBeenCalledTimes(1);
  });

  it('stops on an empty page without invoking onChunk', async () => {
    const getEvents = vi.fn().mockResolvedValue({ events: [], total: 0, hasMore: true });
    const onChunk = vi.fn();
    const total = await streamReplayEvents({ getEvents, replayId: 'r', onChunk });
    expect(getEvents!).toHaveBeenCalledTimes(1);
    expect(onChunk!).not.toHaveBeenCalled();
    expect(total!).toBe(0);
  });

  it('honors an already-aborted signal (no fetches)', async () => {
    const getEvents = vi.fn();
    const controller = new AbortController();
    controller.abort();
    await streamReplayEvents({
      getEvents,
      replayId: 'r',
      onChunk: () => {},
      signal: controller.signal,
    });
    expect(getEvents!).not.toHaveBeenCalled();
  });
});

// A two-view session manifest: view A (2 segments), then view B (1 segment).
// Each view opens with a full snapshot at index_in_view 0.
function twoViewManifest() {
  return {
    sessionId: 'sess-1',
    storageLayout: 'segmented' as const,
    projectId: 'p1',
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
    const views = computeSessionViews(twoViewManifest());
    expect(views).toHaveLength(2);
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
    const snapshots = stitched.filter((e) => e.type === RRWEB_FULL_SNAPSHOT);
    expect(snapshots).toHaveLength(2);
    expect(result.segmentCount).toBe(3);
    expect(result.eventCount).toBe(6);
    expect(result.durationMs).toBe(20_000);
  });

  it('reports the manifest via onManifest before streaming events', async () => {
    const manifest = twoViewManifest();
    const seen: string[] = [];
    await streamSessionSegments({
      getManifest: vi.fn().mockResolvedValue(manifest),
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
