import { useEffect, useMemo, useRef, useState } from 'react';
import { X, AlertCircle, Film } from 'lucide-react';
// rrweb-player UMD bundle + stylesheet, inlined into the sandboxed iframe as raw
// text (Vite `?raw`). Import the UMD file by relative path — the package exports
// map hides it, and a Vite alias + `?raw` gets mis-handled by optimizeDeps in dev.
import playerJs from '../../node_modules/rrweb-player/dist/rrweb-player.umd.min.cjs?raw';
import playerCss from 'rrweb-player/dist/style.css?raw';
import { api } from '../utils/api';
import {
  REPLAY_CHANNEL,
  buildReplayPlayerDataUrl,
  streamReplayEvents,
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
 * Reachable from a bug support ticket (pass the replay id parsed from
 * `replay_ref`) and from a converted kanban card (resolve the id via
 * `GET /board/cards/:cardId/replay`).
 */
export default function ReplayPlayerModal({ replayId, title = 'Session replay', onClose }: any) {
  const iframeRef = useRef<any>(null);
  const startedRef = useRef(false);
  // Holds the current effect's `startStreaming` so the iframe `onLoad` handler
  // can trigger it. `onLoad` fires only after the sandbox's inline bootstrap has
  // executed and registered its own `message` listener, so a chunk posted from
  // here can't be missed — this is the race-free start path.
  const startStreamingRef = useRef<any>(null);
  const [status, setStatus] = useState('connecting'); // connecting | streaming | playing | error
  const [progress, setProgress] = useState({ loaded: 0, total: 0 });
  const [errorMsg, setErrorMsg] = useState<any>(null);

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
    if (!replayId) return undefined;
    const controller = new AbortController();
    let cancelled = false;

    const postToIframe = (msg: any) => {
      const win = iframeRef.current?.contentWindow;
      if (win) win.postMessage({ ch: REPLAY_CHANNEL, ...msg }, '*');
    };

    const startStreaming = async () => {
      if (startedRef.current) return;
      startedRef.current = true;
      setStatus('streaming');
      try {
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
    };
  }, [replayId]);

  // Race-free start: fires after the sandbox's inline bootstrap has run and is
  // listening, so streamed chunks can't be dropped.
  const handleIframeLoad = () => startStreamingRef.current?.();

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
          <button
            onClick={onClose}
            className="ml-auto text-gray-500 hover:text-gray-200 transition-colors"
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
      </div>
    </div>
  );
}
