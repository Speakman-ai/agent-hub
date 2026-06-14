import { useEffect, useMemo, useRef, useState } from 'react';
import { X, AlertCircle, Film } from 'lucide-react';
// rrweb-player UMD bundle + stylesheet, inlined into the sandboxed iframe as raw
// text (Vite `?raw`). Pinned to the same rrweb major (2.x) the recorder uses so
// the stored event format plays back faithfully.
import playerJs from 'rrweb-player-umd?raw';
import playerCss from 'rrweb-player/dist/style.css?raw';
import { api } from '../utils/api.js';
import {
  REPLAY_CHANNEL,
  buildReplayPlayerSrcDoc,
  streamReplayEvents,
} from '../utils/replayPlayer.js';

/**
 * Full-screen modal that plays a stored rrweb session replay inside a
 * `sandbox="allow-scripts"` iframe (the DesignView / SessionPreviewPane
 * isolation pattern). The iframe is an opaque-origin document with no access to
 * the host page, cookies, or network — so it can't fetch the (sensitive,
 * masked-DOM) events itself. Instead the host streams the already-authorized
 * event pages in over postMessage and the sandbox only renders them.
 *
 * Reachable from a bug support ticket (pass the replay id parsed from
 * `replay_ref`) and from a converted kanban card (resolve the id via
 * `GET /board/cards/:cardId/replay`).
 */
export default function ReplayPlayerModal({ replayId, title = 'Session replay', onClose }) {
  const iframeRef = useRef(null);
  const startedRef = useRef(false);
  // Holds the current effect's `startStreaming` so the iframe `onLoad` handler
  // can trigger it. `onLoad` fires only after the sandbox's inline bootstrap has
  // executed and registered its own `message` listener, so a chunk posted from
  // here can't be missed — this is the race-free start path.
  const startStreamingRef = useRef(null);
  const [status, setStatus] = useState('connecting'); // connecting | streaming | playing | error
  const [progress, setProgress] = useState({ loaded: 0, total: 0 });
  const [errorMsg, setErrorMsg] = useState(null);

  // Build the player document once. Stable across renders so the iframe isn't
  // torn down and rebuilt mid-stream.
  const srcDoc = useMemo(() => buildReplayPlayerSrcDoc(playerJs, playerCss), []);

  // Close on Escape.
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') onClose?.();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  useEffect(() => {
    if (!replayId) return undefined;
    const controller = new AbortController();
    let cancelled = false;

    const postToIframe = (msg) => {
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
            setProgress((p) => ({ ...p, total: meta.eventCount }));
          }
        } catch {
          /* metadata is best-effort; the events endpoint is the source of truth */
        }

        const total = await streamReplayEvents({
          getEvents: (id, offset, limit) => api.getReplayEvents(id, offset, limit),
          replayId,
          pageSize,
          signal: controller.signal,
          onChunk: (events, page) => {
            if (cancelled) return;
            postToIframe({ type: 'chunk', events });
            setProgress({
              loaded: (page?.offset ?? 0) + events.length,
              total: page?.total ?? 0,
            });
          },
        });
        if (cancelled) return;
        setProgress((p) => ({ loaded: p.loaded, total: total || p.total }));
        postToIframe({ type: 'end' });
      } catch (err) {
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

    const onMessage = (e) => {
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
    // If the iframe already loaded before this effect ran (fast srcDoc, or a
    // re-subscribe), kick off immediately instead of waiting for an onLoad that
    // already fired.
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
        onClick={(e) => e.stopPropagation()}
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
            srcDoc={srcDoc}
            sandbox="allow-scripts"
            onLoad={handleIframeLoad}
            className="w-full h-full border-0"
            data-testid="replay-player-iframe"
          />
        </div>
      </div>
    </div>
  );
}
