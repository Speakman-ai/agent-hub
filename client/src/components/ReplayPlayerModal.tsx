import { useEffect, useMemo, useRef, useState } from 'react';
import { X, AlertCircle, Film, Layers, Star, Loader2 } from 'lucide-react';
// rrweb-player UMD bundle + stylesheet, inlined into the sandboxed iframe as raw
// text (Vite `?raw`). Import the UMD file by relative path — the package exports
// map hides it, and a Vite alias + `?raw` gets mis-handled by optimizeDeps in dev.
import playerJs from '../../node_modules/rrweb-player/dist/rrweb-player.umd.min.cjs?raw';
import playerCss from 'rrweb-player/dist/style.css?raw';
import { api } from '../utils/api';
import { formatReplayDuration } from '../utils/replayFormat';
import {
  REPLAY_CHANNEL,
  buildReplayPlayerDataUrl,
  computeSessionViews,
  streamReplayEvents,
  streamSessionSegments,
} from '../utils/replayPlayer';

/**
 * Full-screen modal that plays a stored rrweb session replay inside an
 * isolated-origin iframe. The player document is loaded as a `data:` URL, which
 * gives the frame an OPAQUE origin distinct from the Agent Hub app — so it is
 * cross-origin to the host and cannot read the host `document`, cookies, or
 * `localStorage` (those throw SecurityError; proven in
 * e2e/tests/replay-player.spec.ts). That cross-origin boundary is why the host
 * can't hand the (sensitive, masked-DOM) events to the frame directly: it
 * streams the already-authorized event pages in over postMessage and the frame
 * only renders them.
 *
 * The iframe also carries `sandbox="allow-scripts allow-same-origin"`. Here
 * `allow-same-origin` does NOT grant the host origin (a data: document's origin
 * is opaque regardless) — it only stops the sandbox from minting a *fresh*
 * opaque origin per nested frame. rrweb's Replayer rebuilds the captured DOM
 * into a nested iframe it creates; that child must share the parent's opaque
 * origin to be writable, otherwise the page renders blank while the controller
 * bar + mouse cursor (drawn in the outer doc) still animate. The remaining
 * sandbox restrictions (no top-navigation / forms / popups / modals) stay in
 * force, and {@link PLAYER_CSP} blocks all network egress as defense-in-depth.
 * See the isolation-model note in utils/replayPlayer.ts for the full rationale.
 *
 * Two playback modes:
 *  - `replayId` — a monolithic capture. Streams the paginated
 *    `GET /replays/:id/events` pages (bug tickets, converted kanban cards).
 *  - `sessionId` — a segmented (continuous) capture. Fetches the session
 *    manifest and stitches every view's segments into ONE continuous rrweb
 *    timeline (RUM Session Explorer). Each view opens with a fresh full
 *    snapshot, so rrweb rebuilds the DOM at each view boundary; the chapter
 *    markers below the player seek across those boundaries via `goto`.
 *
 * Reachable from a bug support ticket (pass the replay id parsed from
 * `replay_ref`), a converted kanban card (resolve the id via
 * `GET /board/cards/:cardId/replay`), and the RUM Session Explorer (pass the
 * client-minted `sessionId`).
 */
export default function ReplayPlayerModal({
  replayId,
  sessionId,
  title = 'Session replay',
  onClose,
}: any) {
  const iframeRef = useRef<any>(null);
  const startedRef = useRef(false);
  // Session (segmented) mode when a sessionId is given and no replayId.
  const sessionMode = Boolean(sessionId) && !replayId;
  // Holds the current effect's `startStreaming` so the iframe `onLoad` handler
  // can trigger it. `onLoad` fires only after the sandbox's inline bootstrap has
  // executed and registered its own `message` listener, so a chunk posted from
  // here can't be missed — this is the race-free start path.
  const startStreamingRef = useRef<any>(null);
  const [status, setStatus] = useState('connecting'); // connecting | streaming | playing | error
  const [progress, setProgress] = useState({ loaded: 0, total: 0 });
  const [errorMsg, setErrorMsg] = useState<any>(null);
  // View chapter markers (session mode only) — one per view in playback order,
  // each carrying the ms offset a `goto` seeks to on the stitched timeline.
  const [views, setViews] = useState<any[]>([]);
  // Extended-retention flag for a monolithic capture (has a session_replays row).
  // `retainedUntil` is the absolute keep-until instant, or null when on the
  // default window; `flagBusy` guards the toggle in flight.
  const [retainedUntil, setRetainedUntil] = useState<string | null>(null);
  const [flagBusy, setFlagBusy] = useState(false);

  // Load the flag state for a monolithic capture (best-effort; the player still
  // works if this fails). Segmented session playback has no session_replays row,
  // so retention flagging is not offered there.
  useEffect(() => {
    if (!replayId) return;
    let cancelled = false;
    void (async () => {
      try {
        const meta = await api.getReplay(replayId);
        if (!cancelled) setRetainedUntil(meta?.retainedUntil ?? null);
      } catch {
        /* metadata is best-effort */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [replayId]);

  const toggleRetention = async () => {
    if (!replayId || flagBusy) return;
    const next = !retainedUntil;
    setFlagBusy(true);
    try {
      const updated = await api.setReplayRetention(replayId, next);
      // Prefer the server's echoed `retainedUntil`. The fallback (used only if
      // the response omitted it) is a truthiness sentinel for the Kept/Keep
      // label, so format it as SQLite-UTC (`YYYY-MM-DD HH:MM:SS`) to match what
      // the server stores/returns rather than ISO-8601 with T/Z/millis.
      const nowSqliteUtc = new Date().toISOString().slice(0, 19).replace('T', ' ');
      setRetainedUntil(updated?.retainedUntil ?? (next ? nowSqliteUtc : null));
    } catch {
      /* leave the prior state; the button re-enables for a retry */
    } finally {
      setFlagBusy(false);
    }
  };

  // Build the player document once, as an isolated-origin data: URL. Stable
  // across renders so the iframe isn't torn down and rebuilt mid-stream.
  const playerSrc = useMemo(() => buildReplayPlayerDataUrl(playerJs, playerCss), []);

  // Close on Escape.
  useEffect(() => {
    const onKey = (e: any) => {
      if (e.key === 'Escape') onClose?.();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  useEffect(() => {
    if (!replayId && !sessionId) return undefined;
    const controller = new AbortController();
    let cancelled = false;

    const postToIframe = (msg: any) => {
      const win = iframeRef.current?.contentWindow;
      if (win) win.postMessage({ ch: REPLAY_CHANNEL, ...msg }, '*');
    };

    // Segmented (continuous) session: fetch the manifest, then stitch every
    // view's segments into one continuous timeline the player concatenates.
    const streamSession = async () => {
      let loaded = 0;
      const { eventCount } = await streamSessionSegments({
        getManifest: (id: string) => api.getSessionSegments(id),
        getSegmentEvents: (id: string, segId: string) => api.getSessionSegmentEvents(id, segId),
        sessionId,
        signal: controller.signal,
        onManifest: (manifest: any) => {
          if (cancelled) return;
          setViews(computeSessionViews(manifest));
          const total = Array.isArray(manifest?.segments)
            ? manifest.segments.reduce((n: number, s: any) => n + (s?.eventCount || 0), 0)
            : 0;
          if (total) setProgress((p: any) => ({ ...p, total }));
        },
        onChunk: (events: any) => {
          if (cancelled) return;
          postToIframe({ type: 'chunk', events });
          loaded += events.length;
          setProgress((p: any) => ({ loaded, total: p.total }));
        },
      });
      if (cancelled) return;
      setProgress((p: any) => ({ loaded: eventCount || p.loaded, total: eventCount || p.total }));
      postToIframe({ type: 'end' });
    };

    // Monolithic capture: walk the paginated events endpoint.
    const streamMonolithic = async () => {
      // Metadata gives the server's preferred page size + a known total so the
      // progress bar isn't a guess. Both are advisory — streaming derives the
      // real total from the pages it walks.
      let pageSize = 1000;
      try {
        const meta = await api.getReplay(replayId);
        if (meta?.defaultPageSize) pageSize = meta.defaultPageSize;
        if (typeof meta?.eventCount === 'number') {
          setProgress((p: any) => ({ ...p, total: meta.eventCount }));
        }
      } catch {
        /* metadata is best-effort; the events endpoint is the source of truth */
      }

      const total = await streamReplayEvents({
        getEvents: (id: any, offset: any, limit: any) => api.getReplayEvents(id, offset, limit),
        replayId,
        pageSize,
        signal: controller.signal,
        onChunk: (events: any, page: any) => {
          if (cancelled) return;
          postToIframe({ type: 'chunk', events });
          setProgress({
            loaded: (page?.offset ?? 0) + events.length,
            total: page?.total ?? 0,
          });
        },
      });
      if (cancelled) return;
      setProgress((p: any) => ({ loaded: p.loaded, total: total || p.total }));
      postToIframe({ type: 'end' });
    };

    const startStreaming = async () => {
      if (startedRef.current) return;
      startedRef.current = true;
      setStatus('streaming');
      try {
        if (sessionMode) await streamSession();
        else await streamMonolithic();
      } catch (err: any) {
        if (cancelled) return;
        const message = err?.message || 'Failed to load replay';
        setErrorMsg(message);
        setStatus('error');
        postToIframe({ type: 'error', message });
      }
    };

    // Expose the start trigger to the iframe's onLoad handler (the race-free
    // path). The `ready` message below is a redundant trigger; both are guarded
    // by `startedRef` so only the first one actually streams.
    startStreamingRef.current = startStreaming;

    const onMessage = (e: any) => {
      // Only trust the player iframe we mounted.
      if (e.source !== iframeRef.current?.contentWindow) return;
      const d = e.data;
      if (!d || typeof d !== 'object' || d.ch !== REPLAY_CHANNEL) return;
      if (d.type === 'ready') {
        startStreaming();
      } else if (d.type === 'playing') {
        if (!cancelled) setStatus('playing');
      } else if (d.type === 'error') {
        if (!cancelled) {
          setErrorMsg(d.message || 'Playback failed');
          setStatus('error');
        }
      }
    };

    window.addEventListener('message', onMessage);
    // Belt-and-suspenders early start: if the iframe somehow already loaded
    // before this effect ran, kick off without waiting for onLoad. Note the
    // player frame is cross-origin (data: opaque origin), so contentDocument
    // reads back null and this branch is normally inert — the race-free start is
    // the iframe `onLoad` handler, backstopped by the bootstrap's `ready` re-post.
    if (iframeRef.current?.contentDocument?.readyState === 'complete') {
      startStreaming();
    }
    return () => {
      cancelled = true;
      controller.abort();
      window.removeEventListener('message', onMessage);
      startStreamingRef.current = null;
      startedRef.current = false;
      setViews([]);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [replayId, sessionId]);

  // Race-free start: fires after the sandbox's inline bootstrap has run and is
  // listening, so streamed chunks can't be dropped.
  const handleIframeLoad = () => startStreamingRef.current?.();

  // Seek the stitched timeline to a view's start. rrweb rebuilds the DOM from
  // that view's full snapshot, so this crosses view boundaries cleanly.
  const jumpToView = (offsetMs: number) => {
    const win = iframeRef.current?.contentWindow;
    if (win) win.postMessage({ ch: REPLAY_CHANNEL, type: 'goto', offsetMs }, '*');
  };

  const statusLabel =
    status === 'connecting'
      ? 'Loading player…'
      : status === 'streaming'
        ? progress.total
          ? `Streaming events ${Math.min(progress.loaded, progress.total)}/${progress.total}`
          : `Streaming events ${progress.loaded}`
        : status === 'playing'
          ? 'Playing'
          : 'Error';

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4"
      onClick={onClose}
      data-testid="replay-player-overlay"
    >
      <div
        className="flex flex-col w-full max-w-5xl h-[85vh] bg-gray-950 border border-gray-800 rounded-xl overflow-hidden shadow-2xl"
        onClick={(e: any) => e.stopPropagation()}
      >
        <div className="flex items-center gap-3 px-4 py-2.5 border-b border-gray-800 bg-gray-900/60">
          <Film size={15} className="text-blue-400 flex-shrink-0" />
          <span className="text-sm font-medium text-gray-200 truncate">{title}</span>
          <span className="text-[11px] text-gray-500 ml-2">{statusLabel}</span>
          {replayId && (
            <button
              onClick={toggleRetention}
              disabled={flagBusy}
              className={`ml-auto flex items-center gap-1.5 text-[11px] font-medium px-2 py-1 rounded-md transition-colors disabled:opacity-50 ${
                retainedUntil
                  ? 'text-amber-300 bg-amber-500/10 hover:bg-amber-500/20'
                  : 'text-gray-400 hover:text-gray-200 hover:bg-gray-800'
              }`}
              title={
                retainedUntil
                  ? 'Kept for extended retention — click to remove'
                  : 'Keep this session (extended retention, up to 15 months)'
              }
              role="switch"
              aria-checked={Boolean(retainedUntil)}
              aria-label="Toggle extended retention for this session"
              data-testid="replay-retention-toggle"
            >
              {flagBusy ? (
                <Loader2 size={12} className="animate-spin" />
              ) : (
                <Star size={12} className={retainedUntil ? 'fill-amber-300' : ''} />
              )}
              {retainedUntil ? 'Kept' : 'Keep'}
            </button>
          )}
          <button
            onClick={onClose}
            className={`text-gray-500 hover:text-gray-200 transition-colors ${
              replayId ? '' : 'ml-auto'
            }`}
            title="Close (Esc)"
            data-testid="replay-player-close"
          >
            <X size={16} />
          </button>
        </div>

        <div className="relative flex-1 min-h-0 bg-[#0b0d12]">
          {status === 'error' ? (
            <div className="absolute inset-0 flex items-center justify-center">
              <div className="text-center px-6">
                <AlertCircle size={28} className="mx-auto mb-2 text-red-400" />
                <p className="text-sm text-red-400">{errorMsg || 'Failed to load replay'}</p>
              </div>
            </div>
          ) : null}
          {status !== 'playing' && status !== 'error' ? (
            <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
              <div className="flex items-center gap-2 text-gray-500">
                <div className="animate-spin w-4 h-4 border-2 border-gray-600 border-t-gray-300 rounded-full" />
                <span className="text-xs">{statusLabel}</span>
              </div>
            </div>
          ) : null}
          <iframe
            ref={iframeRef}
            title="Session replay player"
            // Loaded as a data: URL (NOT srcDoc) so the frame runs at an opaque
            // origin, cross-origin to the host app — it cannot reach host DOM /
            // cookies / storage. allow-same-origin keeps rrweb's nested replay
            // frame same-origin to *this* opaque origin (not the host's) so the
            // rebuild lands. See the component-level comment + replayPlayer.ts.
            src={playerSrc}
            sandbox="allow-scripts allow-same-origin"
            onLoad={handleIframeLoad}
            className="w-full h-full border-0"
            data-testid="replay-player-iframe"
          />
        </div>

        {/* View chapter markers (segmented sessions with >1 view). Each seeks the
            stitched, continuous timeline to that view's full snapshot. */}
        {sessionMode && views.length > 1 ? (
          <div
            className="flex items-center gap-1.5 px-3 py-2 border-t border-gray-800 bg-gray-900/60 overflow-x-auto"
            data-testid="replay-view-chapters"
          >
            <Layers size={13} className="text-gray-500 flex-shrink-0" />
            <span className="text-[11px] uppercase tracking-wide text-gray-600 flex-shrink-0 mr-1">
              {views.length} views
            </span>
            {views.map((v: any) => (
              <button
                key={v.viewId}
                type="button"
                onClick={() => jumpToView(v.offsetMs)}
                disabled={status !== 'playing'}
                title={`View ${v.index + 1} · ${formatReplayDuration(v.offsetMs)}`}
                className="flex-shrink-0 px-2 py-1 rounded border border-gray-700 text-[11px] text-gray-300 hover:bg-gray-800 hover:border-gray-600 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                data-testid="replay-view-chapter"
              >
                View {v.index + 1}
                <span className="text-gray-500 ml-1">{formatReplayDuration(v.offsetMs)}</span>
              </button>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}
