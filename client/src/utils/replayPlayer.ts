// Sandboxed rrweb-player playback — pure helpers (no JSX, no `?raw` imports) so
// they stay unit-testable without the bundler. ReplayPlayerModal imports the
// rrweb-player UMD + CSS as raw strings, builds the player document with
// `buildReplayPlayerSrcDoc`, and loads it via `buildReplayPlayerDataUrl`.
//
// ISOLATION MODEL — isolated opaque origin, NOT same-origin to the host app.
// The player document is loaded as a `data:` URL (`buildReplayPlayerDataUrl`),
// which gives it an OPAQUE origin distinct from the Agent Hub app origin. The
// frame is therefore CROSS-origin to the host: it cannot read the host
// `document`, cookies, or `localStorage` (those accesses throw SecurityError) —
// proven in e2e/tests/replay-player.spec.ts. This is the primary trust boundary
// for sensitive (masked-DOM) replay content, so a compromised dependency, a
// player-bundle bug, or rrweb-rendered active content still cannot reach host
// state. CSP (below) is defense-in-depth (no network), not the only boundary.
//
// The iframe also carries `sandbox="allow-scripts allow-same-origin"`. Here
// `allow-same-origin` does NOT grant the host origin — the data: document's
// origin is opaque regardless. It only stops the sandbox from minting a *fresh*
// opaque origin per nested frame, so rrweb's Replayer (which rebuilds the
// captured DOM into a nested iframe it creates) gets a child frame that shares
// the parent's opaque origin and can be written into. With `allow-scripts`
// alone the nested frame gets its own opaque origin, the player can't reach its
// contentDocument (cross-origin), and the page renders blank while the
// controller bar + cursor still animate. The remaining sandbox restrictions
// (no top-navigation / forms / popups / modals) stay in force.
//
// Because the frame is cross-origin and unauthenticated, the parent streams the
// (already-authorized) event pages in over postMessage and the iframe only ever
// renders them.

// postMessage channel tag. Both directions carry `{ ch: REPLAY_CHANNEL }` so the
// host and the sandbox can ignore unrelated messages (extensions, other frames).
export const REPLAY_CHANNEL = 'ah-replay';

/**
 * Parse the replay id out of a `/uploads/replay-<id>.json` ref (the form stored
 * on a bug ticket's `replay_ref`). Returns null for anything that doesn't match,
 * so callers can cheaply decide whether a "Watch replay" affordance applies.
 */
export function parseReplayIdFromRef(ref: any) {
  if (!ref || typeof ref !== 'string') return null;
  const m = ref.match(/replay-([A-Za-z0-9._-]+)\.json(?:\?.*)?$/);
  return m ? m[1] : null;
}

/**
 * Neutralize a literal `</script` inside a string that will be inlined into an
 * HTML `<script>` block, so the bundle (or CSS) can't prematurely close the tag.
 */
export function escapeForScript(text: string) {
  // Case-insensitive: the HTML parser closes a <script> on any-case </script>.
  return String(text).replace(/<\/script/gi, '<\\/script');
}

// In-iframe controller. Accumulates streamed event chunks and, on `end`,
// instantiates rrweb-player against them.
//
// CRITICAL: this is a string of *raw JavaScript* inlined verbatim into the
// sandboxed iframe's <script>. It is NOT type-checked or transpiled — the
// browser parses it as-is. Do NOT add TypeScript syntax (type annotations,
// `as`, generics) here: a `: any` on a param or catch binding makes the inline
// script a SyntaxError, the bootstrap never runs, and the player silently never
// renders (stuck "Streaming events …" spinner). The `replayPlayer.test.ts`
// "is valid JavaScript" test guards this. It must not reference anything from
// the parent scope either.
export const IFRAME_BOOTSTRAP = `(function () {
  var CH = ${JSON.stringify(REPLAY_CHANNEL)};
  var events = [];
  var built = false;
  var acked = false;
  var player = null;
  function post(msg) {
    try { parent.postMessage(Object.assign({ ch: CH }, msg), '*'); } catch (e) {}
  }
  function build() {
    if (built) return;
    built = true;
    if (!events.length) { post({ type: 'error', message: 'Replay has no events' }); return; }
    var ns = window.rrwebPlayer || {};
    var Player = ns.default || ns.Player || ns;
    if (typeof Player !== 'function') { post({ type: 'error', message: 'rrweb-player failed to load' }); return; }
    var root = document.getElementById('root');
    root.innerHTML = '';
    var FRAME_PADDING = 24;
    var CONTROLLER_HEIGHT = 80;
    var width = Math.max(320, window.innerWidth - FRAME_PADDING);
    // rrweb-player renders the controller below the replay frame and adds this
    // height back onto the outer .rr-player. Size only the replay frame here so
    // the scrubber and play/pause controls stay inside the iframe viewport.
    var availableHeight = Math.max(1, window.innerHeight - FRAME_PADDING);
    var height = Math.max(1, availableHeight - CONTROLLER_HEIGHT);
    try {
      // Keep the instance so the parent can drive cross-view seeks (goto) — a
      // stitched multi-view session shares one continuous timeline, and rrweb
      // rebuilds the DOM from each view's full snapshot when the offset lands in
      // a later view.
      player = new Player({
        target: root,
        props: { events: events, width: width, height: height, autoPlay: true, showController: true },
      });
      post({ type: 'playing', eventCount: events.length });
    } catch (e) {
      post({ type: 'error', message: (e && e.message) || String(e) });
    }
  }
  window.addEventListener('message', function (e) {
    if (e.source !== window.parent) return;
    var d = e.data;
    if (!d || typeof d !== 'object' || d.ch !== CH) return;
    // First parent message confirms the handshake landed — stop re-announcing.
    acked = true;
    if (d.type === 'chunk' && Array.isArray(d.events)) {
      events = events.concat(d.events);
      post({ type: 'chunk-ack', received: events.length });
    } else if (d.type === 'end') {
      build();
    } else if (d.type === 'goto') {
      // Seek to a time offset (ms from the session's first event) — used by the
      // view-chapter markers to jump across view boundaries on one timeline.
      if (player && typeof player.goto === 'function' && typeof d.offsetMs === 'number') {
        try { player.goto(Math.max(0, d.offsetMs)); } catch (err) {}
      }
    } else if (d.type === 'error') {
      post({ type: 'error', message: d.message || 'Failed to load replay' });
    }
  });
  // Announce readiness. The parent's primary start trigger is the iframe's
  // onLoad (which fires after this script runs, so it can't race the listener
  // above), but if that's ever missed we keep re-posting 'ready' until the
  // parent first responds — belt-and-suspenders against a dropped handshake.
  post({ type: 'ready' });
  var tries = 0;
  var readyTimer = setInterval(function () {
    if (acked || tries >= 40) { clearInterval(readyTimer); return; }
    tries += 1;
    post({ type: 'ready' });
  }, 150);
})();`;

// Content-Security-Policy for the player document. Host isolation is provided by
// the data: URL's opaque origin (see the isolation-model note at the top of this
// file), so this CSP is defense-in-depth, not the only boundary. Its key job is
// to block ALL network egress from the frame — and rrweb rehydrates
// captured DOM that can reference remote images/fonts/media/iframes/stylesheets.
// This locks the document down to a no-network island:
//   - `default-src 'none'`           — deny everything unless re-allowed below.
//   - `script-src 'unsafe-inline'`   — only our inlined player bundle + bootstrap
//                                       run; no remote or eval'd scripts (the
//                                       rrweb rebuild renders recorded scripts
//                                       inert, and the bundle uses no eval).
//   - `style-src 'unsafe-inline'`    — inlined player CSS + rrweb's reconstructed
//                                       inline styles; no remote stylesheets.
//   - `img-src/font-src/media-src`   — data:/blob: only (embedded, not network);
//                                       remote replayed assets are blocked.
//   - `connect-src 'none'`           — no fetch / XHR / WebSocket / sendBeacon.
//   - `frame-src/child-src 'self' blob: data:` — rrweb's Replayer renders the
//                                       captured DOM into an iframe it creates
//                                       via createElement (the initial
//                                       about:blank, no src), so the policy must
//                                       permit that internal frame or playback
//                                       never renders. `'self'` (the document's
//                                       own opaque origin) + `blob:`/`data:`
//                                       cover that mechanism; a replayed iframe
//                                       with a remote `http(s)` src still fails
//                                       to load, so remote frames stay blocked.
// No remote `http(s)` source is whitelisted anywhere, so the frame stays a
// no-network island. Verified end-to-end in e2e/tests/replay-player.spec.js,
// which renders a real recording through this exact srcDoc under a real browser.
export const PLAYER_CSP =
  "default-src 'none'; " +
  "script-src 'unsafe-inline'; " +
  "style-src 'unsafe-inline'; " +
  'img-src data: blob:; ' +
  'font-src data:; ' +
  'media-src data: blob:; ' +
  "connect-src 'none'; " +
  "frame-src 'self' blob: data:; " +
  "child-src 'self' blob: data:; " +
  "worker-src 'none'; " +
  "object-src 'none'; " +
  "base-uri 'none'; " +
  "form-action 'none'";

/**
 * Build the player document HTML. `playerJs` is the rrweb-player UMD bundle
 * (exposes `window.rrwebPlayer`); `playerCss` is its stylesheet. Both are inlined
 * so the frame needs no network, and a restrictive CSP (see {@link PLAYER_CSP})
 * enforces that no-network property even against the replayed DOM rrweb
 * reconstructs. The document is loaded via {@link buildReplayPlayerDataUrl} so it
 * runs at an isolated opaque origin (see the isolation-model note at the top of
 * this file) — the name keeps `Doc` for historical reasons but it is no longer
 * passed to the iframe `srcDoc` attribute.
 */
export function buildReplayPlayerSrcDoc(playerJs?: string, playerCss?: string) {
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<meta http-equiv="Content-Security-Policy" content="${PLAYER_CSP}" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<style>${escapeForScript(playerCss || '')}</style>
<style>
  html, body { margin: 0; padding: 0; background: #0b0d12; height: 100%; overflow: hidden; }
  #root { display: flex; align-items: center; justify-content: center; min-height: 100vh; padding: 12px; box-sizing: border-box; }
  .rr-player { box-shadow: 0 0 0 1px rgba(255,255,255,0.06); border-radius: 6px; }
</style>
</head>
<body>
<div id="root"></div>
<script>${escapeForScript(playerJs || '')}</script>
<script>${escapeForScript(IFRAME_BOOTSTRAP)}</script>
</body>
</html>`;
}

/**
 * Wrap the player document in a `data:text/html` URL. Loading the iframe from
 * this (rather than the `srcDoc` attribute) is what gives the frame an OPAQUE
 * origin distinct from the Agent Hub app, so it is cross-origin to the host and
 * cannot reach host `document` / cookies / `localStorage`. A `srcDoc` document,
 * by contrast, inherits the host origin — and `blob:` URLs inherit the creating
 * (host) origin too — so only a data: URL achieves host isolation here. See the
 * isolation-model note at the top of this file.
 *
 * `encodeURIComponent` (not base64) keeps UTF-8 in the inlined CSS/bundle intact
 * and avoids `btoa` throwing on non-Latin1 characters.
 */
export function buildReplayPlayerDataUrl(playerJs?: string, playerCss?: string) {
  return (
    'data:text/html;charset=utf-8,' +
    encodeURIComponent(buildReplayPlayerSrcDoc(playerJs, playerCss))
  );
}

/**
 * Walk the paginated replay-events API, invoking `onChunk(events, page)` for each
 * non-empty page. Pure over its injected `getEvents(replayId, offset, limit)` so
 * it's testable without a network. Returns the total event count reported by the
 * API. Honors an optional AbortSignal between pages.
 */
export async function streamReplayEvents({
  getEvents,
  replayId,
  pageSize = 1000,
  onChunk,
  signal,
}: {
  getEvents: (
    replayId: string,
    offset: number,
    limit: number,
  ) => Promise<{
    events?: unknown[];
    total?: number;
    hasMore?: boolean;
  }>;
  replayId: string;
  pageSize?: number;
  onChunk?: (
    events: unknown[],
    page: { events?: unknown[]; total?: number; hasMore?: boolean },
  ) => void;
  signal?: AbortSignal;
}) {
  let offset = 0;
  let total = 0;
  // Hard ceiling on iterations as a runaway guard against a misbehaving API
  // that never sets hasMore=false (e.g. always returns the same page).
  for (let i = 0; i < 100000; i += 1) {
    if (signal && signal.aborted) return total;
    const page = await getEvents(replayId, offset, pageSize);
    const events: unknown[] = Array.isArray(page?.events) ? page.events : [];
    if (typeof page?.total === 'number') total = page.total;
    if (events.length && typeof onChunk === 'function') onChunk(events, page);
    offset += events.length;
    if (!page || !page.hasMore || events.length === 0) break;
  }
  return total;
}

// ── Session-grouped multi-view playback (segmented captures) ──────────────
// A continuous (segmented) capture is stored as per-segment objects grouped
// session → view → segment (see server/replays/segment-store.ts). The player
// fetches the session manifest, then pulls each segment's events in playback
// order and concatenates them into ONE continuous rrweb timeline. Every view
// opens with a fresh full snapshot (`hasFullSnapshot`, indexInView 0), so
// concatenating in manifest order lets rrweb rebuild the DOM at each view
// boundary and seek across boundaries natively.

// rrweb EventType.FullSnapshot — the event that starts each view. Kept here so
// the stitch helpers can reason about view boundaries without importing rrweb.
export const RRWEB_FULL_SNAPSHOT = 2;

/**
 * One playback-manifest segment entry (subset the player reads). Mirrors the
 * server `SegmentManifestEntry`.
 */
export interface SessionSegmentEntry {
  segmentId: string;
  viewId: string;
  indexInView: number;
  hasFullSnapshot: boolean;
  startTs: number;
  endTs: number;
  eventCount: number;
  byteSize?: number;
  eventsUrl?: string;
}

/** The session playback manifest (subset). Mirrors server `SessionSegmentManifest`. */
export interface SessionSegmentManifest {
  sessionId: string;
  storageLayout?: string;
  projectId?: string | null;
  segmentCount?: number;
  durationMs?: number;
  segments?: SessionSegmentEntry[];
}

/** A view chapter marker for the player's timeline: where the view begins on the
 *  stitched, continuous timeline (ms offset from the session's first event). */
export interface SessionViewChapter {
  viewId: string;
  /** 0-based ordinal in playback order. */
  index: number;
  /** Absolute timestamp of the view's first segment. */
  startTs: number;
  /** ms offset from the session's first event — what rrweb-player `goto` takes. */
  offsetMs: number;
}

/**
 * Collapse a session manifest into ordered per-view chapter markers. Segments
 * arrive in playback order and are view-scoped (a view never spans segments of
 * another view), so the first occurrence of each `viewId` is that view's start.
 * `offsetMs` is the view's first-segment start relative to the earliest segment
 * start in the session — the same origin rrweb-player's timeline uses — so a
 * chapter click maps directly to `player.goto(offsetMs)`. Pure and
 * side-effect-free for unit testing.
 */
export function computeSessionViews(
  manifest?: SessionSegmentManifest | null,
): SessionViewChapter[] {
  const segments = Array.isArray(manifest?.segments) ? manifest!.segments! : [];
  if (!segments.length) return [];
  let sessionStart = Infinity;
  for (const s of segments) {
    if (typeof s?.startTs === 'number' && s.startTs < sessionStart) sessionStart = s.startTs;
  }
  if (!Number.isFinite(sessionStart)) sessionStart = 0;
  const chapters: SessionViewChapter[] = [];
  const seen = new Set<string>();
  for (const s of segments) {
    if (!s || seen.has(s.viewId)) continue;
    seen.add(s.viewId);
    const startTs = typeof s.startTs === 'number' ? s.startTs : sessionStart;
    chapters.push({
      viewId: s.viewId,
      index: chapters.length,
      startTs,
      offsetMs: Math.max(0, startTs - sessionStart),
    });
  }
  return chapters;
}

/**
 * Fetch a session's segment manifest, then walk its segments IN PLAYBACK ORDER,
 * fetching each segment's events and invoking `onChunk(events, segment)` so the
 * caller can stream them into the player and concatenate them into one
 * continuous timeline. Pure over its injected `getManifest` / `getSegmentEvents`
 * so it's testable without a network. Honors an optional AbortSignal between
 * segments. Returns the manifest plus the total segment/event counts streamed.
 */
export async function streamSessionSegments({
  getManifest,
  getSegmentEvents,
  sessionId,
  onManifest,
  onChunk,
  signal,
}: {
  getManifest: (sessionId: string) => Promise<SessionSegmentManifest>;
  getSegmentEvents: (
    sessionId: string,
    segmentId: string,
  ) => Promise<{ events?: unknown[]; eventCount?: number }>;
  sessionId: string;
  onManifest?: (manifest: SessionSegmentManifest) => void;
  onChunk?: (events: unknown[], segment: SessionSegmentEntry) => void;
  signal?: AbortSignal;
}) {
  const manifest = await getManifest(sessionId);
  if (typeof onManifest === 'function') onManifest(manifest);
  const segments = Array.isArray(manifest?.segments) ? manifest.segments : [];
  let eventCount = 0;
  for (const segment of segments) {
    if (signal && signal.aborted) break;
    const res = await getSegmentEvents(sessionId, segment.segmentId);
    const events: unknown[] = Array.isArray(res?.events) ? res.events : [];
    if (events.length && typeof onChunk === 'function') onChunk(events, segment);
    eventCount += events.length;
  }
  return {
    manifest,
    segmentCount: segments.length,
    eventCount,
    durationMs: typeof manifest?.durationMs === 'number' ? manifest.durationMs : 0,
  };
}

/**
 * The rrweb event index a seek to `targetOffsetMs` rebuilds from: the last full
 * snapshot at or before the target time (mirrors rrweb's own rebuild-from-last-
 * full-snapshot seek). Given a stitched, multi-view timeline this proves a seek
 * into a later view lands on THAT view's snapshot (not view 0's), i.e. seeking
 * across a view boundary is well-formed. `events` must be in timeline order and
 * carry rrweb `{ type, timestamp }`. Returns -1 if no snapshot precedes the
 * target. Pure helper for tests + reasoning about the continuous timeline.
 */
export function seekBaselineIndex(
  events: Array<{ type?: number; timestamp?: number }>,
  targetTimestamp: number,
): number {
  let baseline = -1;
  for (let i = 0; i < events.length; i += 1) {
    const e = events[i];
    if (!e || typeof e.timestamp !== 'number') continue;
    if (e.timestamp > targetTimestamp) break;
    if (e.type === RRWEB_FULL_SNAPSHOT) baseline = i;
  }
  return baseline;
}
