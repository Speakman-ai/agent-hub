// Session-grouped multi-view playback — pure stitch helpers (mobile parity of
// client/src/utils/replayPlayer.ts). A continuous (segmented) capture is stored
// as per-segment objects grouped session → view → segment (see
// server/replays/segment-store.ts). The player fetches the session manifest,
// then pulls each segment's events in playback order and concatenates them into
// ONE continuous rrweb timeline. Every view opens with a fresh full snapshot
// (`hasFullSnapshot`, indexInView 0), so concatenating in manifest order lets
// rrweb rebuild the DOM at each view boundary and seek across boundaries
// natively.
//
// This module carries ONLY the framework-agnostic data layer (manifest walk,
// view chapters, seek-baseline reasoning) so it stays unit-testable without a
// bundler. The in-app rrweb WebView player that consumes these helpers is a
// separate ticket ("Mobile: in-app rrweb WebView replay player"); until it
// lands, ReplaysScreen uses `computeSessionViews` to surface the session's view
// breakdown in the player modal.

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
 * The rrweb event index a seek to `targetTimestamp` rebuilds from: the last full
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

// ── In-app rrweb WebView player ───────────────────────────────────────────
// Mobile parity of client/src/components/ReplayPlayerModal + its inline iframe
// bootstrap. The player document is the SAME sandboxed, no-network island the
// web player builds (rrweb-player UMD + CSS inlined, restrictive CSP), loaded
// into a react-native-webview from a `data:text/html` URL so the frame runs at
// an OPAQUE origin — cross-origin to the RN app, unable to reach its bridge,
// storage, or the loopback Hub. See buildReplayPlayerDataUrl below.
//
// Only the host↔frame transport differs from web. A browser iframe uses
// window.postMessage in both directions; a WebView has no `parent`, so:
//   - frame → RN: window.ReactNativeWebView.postMessage(JSON.stringify(msg))
//     (delivered to the RN <WebView onMessage>). Same {ch,type,...} envelope.
//   - RN → frame: the RN side injects `window.__ahReplayReceive(<json>)` calls
//     (buildInjectedReceive) — a direct, race-free push once the frame has
//     announced `ready`, avoiding WebView postMessage's document/window
//     inconsistency across platforms.

// postMessage/bridge channel tag. Both directions carry `{ ch: REPLAY_CHANNEL }`
// so each side can ignore unrelated messages.
export const REPLAY_CHANNEL = 'ah-replay';

/**
 * Neutralize a literal `</script` inside a string that will be inlined into an
 * HTML `<script>` block so the bundle (or CSS) can't prematurely close the tag.
 * Case-insensitive: the HTML parser closes a <script> on any-case `</script`.
 */
export function escapeForScript(text: string): string {
  return String(text).replace(/<\/script/gi, '<\\/script');
}

// In-WebView controller. Accumulates streamed event chunks and, on `end`,
// instantiates rrweb-player against them; drives cross-view `goto` seeks.
//
// CRITICAL: this is a string of *raw JavaScript* inlined verbatim into the
// WebView document's <script>. It is NOT type-checked or transpiled — do NOT add
// TypeScript syntax here (a `: any` makes it a SyntaxError, the bootstrap never
// runs, and playback silently stalls on "Streaming events …"). The
// "WEBVIEW_BOOTSTRAP is valid JavaScript" test guards this. It must not
// reference anything from the RN scope.
export const WEBVIEW_BOOTSTRAP = `(function () {
  var CH = ${JSON.stringify(REPLAY_CHANNEL)};
  var events = [];
  var built = false;
  var player = null;
  function post(msg) {
    try {
      var rnw = window.ReactNativeWebView;
      if (rnw && typeof rnw.postMessage === 'function') {
        rnw.postMessage(JSON.stringify(Object.assign({ ch: CH }, msg)));
      }
    } catch (e) {}
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
    var availableHeight = Math.max(1, window.innerHeight - FRAME_PADDING);
    var height = Math.max(1, availableHeight - CONTROLLER_HEIGHT);
    try {
      // Keep the instance so the RN side can drive cross-view seeks (goto) on the
      // one stitched, continuous timeline — rrweb rebuilds the DOM from each
      // view's full snapshot when the offset lands in a later view.
      player = new Player({
        target: root,
        props: { events: events, width: width, height: height, autoPlay: true, showController: true },
      });
      post({ type: 'playing', eventCount: events.length });
    } catch (e) {
      post({ type: 'error', message: (e && e.message) || String(e) });
    }
  }
  // RN → WebView push. The RN side calls window.__ahReplayReceive(msg) via
  // injectJavaScript once the frame has announced 'ready', so a chunk can't race
  // the handler registration.
  window.__ahReplayReceive = function (d) {
    if (!d || typeof d !== 'object' || d.ch !== CH) return;
    if (d.type === 'chunk' && Array.isArray(d.events)) {
      events = events.concat(d.events);
      post({ type: 'chunk-ack', received: events.length });
    } else if (d.type === 'end') {
      build();
    } else if (d.type === 'goto') {
      if (player && typeof player.goto === 'function' && typeof d.offsetMs === 'number') {
        try { player.goto(Math.max(0, d.offsetMs)); } catch (err) {}
      }
    } else if (d.type === 'error') {
      post({ type: 'error', message: d.message || 'Failed to load replay' });
    }
  };
  // Announce readiness so the RN side starts streaming (race-free: this runs
  // after the handler above is registered).
  post({ type: 'ready' });
})();`;

// Content-Security-Policy for the player document. Host isolation comes from the
// data: URL's opaque origin; this CSP is defense-in-depth that blocks ALL
// network egress from the frame (rrweb rehydrates captured DOM that can
// reference remote images/fonts/media/iframes). Mirrors the web PLAYER_CSP.
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
 * so the frame needs no network, and {@link PLAYER_CSP} enforces that even
 * against the replayed DOM rrweb reconstructs. Loaded via
 * {@link buildReplayPlayerDataUrl} so it runs at an isolated opaque origin.
 */
export function buildReplayPlayerSrcDoc(playerJs?: string, playerCss?: string): string {
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
<script>${escapeForScript(WEBVIEW_BOOTSTRAP)}</script>
</body>
</html>`;
}

/**
 * Wrap the player document in a `data:text/html` URL. Loading the WebView from
 * this gives the frame an OPAQUE origin distinct from the RN app, so it is
 * cross-origin and cannot reach the RN bridge globals or app storage. Mirrors
 * the web helper (`encodeURIComponent`, not base64, to keep UTF-8 intact).
 */
export function buildReplayPlayerDataUrl(playerJs?: string, playerCss?: string): string {
  return (
    'data:text/html;charset=utf-8,' +
    encodeURIComponent(buildReplayPlayerSrcDoc(playerJs, playerCss))
  );
}

/**
 * The `injectJavaScript` payload that pushes one host→frame message. Returns a
 * self-terminating statement (`; true;`) as react-native-webview expects, with
 * the message JSON-embedded so the frame's `__ahReplayReceive` handler runs it.
 * Pure so the transport is unit-testable without a WebView.
 */
export function buildInjectedReceive(msg: Record<string, unknown>): string {
  return `window.__ahReplayReceive(${JSON.stringify({ ch: REPLAY_CHANNEL, ...msg })});true;`;
}

/**
 * Walk the paginated replay-events API, invoking `onChunk(events, page)` for each
 * non-empty page. Pure over injected `getEvents(replayId, offset, limit)` so it's
 * testable without a network. Returns the total event count reported by the API.
 * Honors an optional AbortSignal between pages. Mirrors the web helper.
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
  ) => Promise<{ events?: unknown[]; total?: number; hasMore?: boolean }>;
  replayId: string;
  pageSize?: number;
  onChunk?: (
    events: unknown[],
    page: { events?: unknown[]; total?: number; hasMore?: boolean },
  ) => void;
  signal?: AbortSignal;
}): Promise<number> {
  let offset = 0;
  let total = 0;
  // Hard ceiling as a runaway guard against an API that never sets hasMore=false.
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

/** Progress for the streaming status line — events pushed vs. known total. */
export interface ReplayStreamProgress {
  loaded: number;
  total: number;
}

/** What the player is asked to render — a segmented session or a monolithic
 *  capture (exactly one of `sessionId` / `replayId`). */
export interface ReplayPlayerTarget {
  mode?: 'session' | 'replay';
  sessionId?: string;
  replayId?: string;
}

/**
 * Stable identity for a player target — a `mode:id` string used to key the
 * WebView (so a target change REMOUNTS the frame, which reloads the player doc
 * and re-emits its one-time `ready` handshake) and to gate the reset effect. The
 * `replayId`-wins precedence matches {@link streamReplayTarget}'s
 * `sessionMode = Boolean(sessionId) && !replayId` branch, so the key and the
 * stream path never disagree about which mode is active. Distinct targets always
 * yield distinct keys — a session and a monolithic capture that happen to share
 * an id do not collide (the `session:` / `replay:` prefix keeps them apart).
 * Returns '' for a null/empty target. Pure so the remount contract is unit-
 * testable without a render harness.
 */
export function replayTargetKey(target?: ReplayPlayerTarget | null): string {
  if (!target) return '';
  if (target.replayId) return `replay:${target.replayId}`;
  if (target.sessionId) return `session:${target.sessionId}`;
  return '';
}

/** Injected reads the orchestration needs — the mobile `api` shape, narrowed. */
export interface ReplayPlayerApi {
  getSessionSegments: (sessionId: string) => Promise<SessionSegmentManifest>;
  getSessionSegmentEvents: (
    sessionId: string,
    segmentId: string,
  ) => Promise<{ events?: unknown[]; eventCount?: number }>;
  getReplay?: (replayId: string) => Promise<{ defaultPageSize?: number; eventCount?: number }>;
  getReplayEvents: (
    replayId: string,
    offset: number,
    limit: number,
  ) => Promise<{ events?: unknown[]; total?: number; hasMore?: boolean }>;
}

/**
 * Drive the full host→frame stream for a target, branching on session (segmented)
 * vs. monolithic mode exactly like the web ReplayPlayerModal. Pushes each event
 * chunk to the frame via `post({ type: 'chunk', events })`, reports progress via
 * `onProgress`, surfaces the session's view chapters via `onViews`, and posts a
 * terminal `{ type: 'end' }`. Pure over its injected `api` + `post` so it's fully
 * unit-testable without a WebView. Honors an AbortSignal (checked between pages /
 * segments by the underlying walkers). Returns the number of events streamed.
 */
export async function streamReplayTarget({
  target,
  api,
  post,
  onViews,
  onProgress,
  signal,
}: {
  target: ReplayPlayerTarget;
  api: ReplayPlayerApi;
  post: (msg: Record<string, unknown>) => void;
  onViews?: (views: SessionViewChapter[]) => void;
  onProgress?: (progress: ReplayStreamProgress) => void;
  signal?: AbortSignal;
}): Promise<number> {
  const sessionMode = Boolean(target?.sessionId) && !target?.replayId;

  if (sessionMode) {
    let loaded = 0;
    let total = 0;
    const { eventCount } = await streamSessionSegments({
      getManifest: (id: string) => api.getSessionSegments(id),
      getSegmentEvents: (id: string, segId: string) => api.getSessionSegmentEvents(id, segId),
      sessionId: target.sessionId as string,
      signal,
      onManifest: (manifest) => {
        onViews?.(computeSessionViews(manifest));
        const segs = Array.isArray(manifest?.segments) ? manifest.segments : [];
        total = segs.reduce((n, s) => n + (s?.eventCount || 0), 0);
        if (total) onProgress?.({ loaded, total });
      },
      onChunk: (events) => {
        post({ type: 'chunk', events });
        loaded += events.length;
        onProgress?.({ loaded, total });
      },
    });
    const finalCount = eventCount || loaded;
    onProgress?.({ loaded: finalCount, total: total || finalCount });
    post({ type: 'end' });
    return finalCount;
  }

  const replayId = target.replayId as string;
  // Metadata gives the server's preferred page size + a known total so the
  // progress line isn't a guess. Both are advisory — the events walk is truth.
  let pageSize = 1000;
  let total = 0;
  try {
    const meta = api.getReplay ? await api.getReplay(replayId) : undefined;
    if (meta?.defaultPageSize) pageSize = meta.defaultPageSize;
    if (typeof meta?.eventCount === 'number') {
      total = meta.eventCount;
      onProgress?.({ loaded: 0, total });
    }
  } catch {
    /* metadata is best-effort; the events endpoint is the source of truth */
  }

  let loaded = 0;
  const walked = await streamReplayEvents({
    getEvents: (id, offset, limit) => api.getReplayEvents(id, offset, limit),
    replayId,
    pageSize,
    signal,
    onChunk: (events, page) => {
      post({ type: 'chunk', events });
      loaded += events.length;
      if (typeof page?.total === 'number') total = page.total;
      onProgress?.({ loaded, total });
    },
  });
  onProgress?.({ loaded, total: walked || total || loaded });
  post({ type: 'end' });
  return walked;
}
