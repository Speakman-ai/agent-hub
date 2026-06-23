// Sandboxed rrweb-player playback — pure helpers (no JSX, no `?raw` imports) so
// they stay unit-testable without the bundler. ReplayPlayerModal.jsx imports the
// rrweb-player UMD + CSS as raw strings and hands them to `buildReplayPlayerSrcDoc`.
//
// The player runs inside a `sandbox="allow-scripts"` iframe (the DesignView /
// SessionPreviewPane isolation pattern): an opaque-origin document with no DOM,
// network, or storage access to the host. It can't make authenticated API calls,
// so the parent streams the (already-authorized) event pages in over postMessage
// and the iframe only ever renders them.

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
// instantiates rrweb-player against them. Kept as a plain string so it can be
// inlined verbatim — it must not reference anything from the parent scope.
const IFRAME_BOOTSTRAP = `(function () {
  var CH = ${JSON.stringify(REPLAY_CHANNEL)};
  var events = [];
  var built = false;
  var acked = false;
  function post(msg: any) {
    try { parent.postMessage(Object.assign({ ch: CH }, msg), '*'); } catch (e: any) {}
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
    var width = Math.max(320, window.innerWidth - 24);
    var height = Math.max(240, window.innerHeight - 24);
    try {
      new Player({
        target: root,
        props: { events: events, width: width, height: height, autoPlay: true, showController: true },
      });
      post({ type: 'playing', eventCount: events.length });
    } catch (e: any) {
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

// Content-Security-Policy for the player document. `sandbox="allow-scripts"`
// alone gives the frame an opaque origin and strips host cookies/storage, but it
// does NOT stop the frame from making network requests — and rrweb rehydrates
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
 * Build the `srcDoc` for the sandboxed player iframe. `playerJs` is the
 * rrweb-player UMD bundle (exposes `window.rrwebPlayer`); `playerCss` is its
 * stylesheet. Both are inlined so the opaque-origin sandbox needs no network,
 * and a restrictive CSP (see {@link PLAYER_CSP}) enforces that no-network
 * property even against the replayed DOM rrweb reconstructs.
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
