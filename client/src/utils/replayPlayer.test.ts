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
