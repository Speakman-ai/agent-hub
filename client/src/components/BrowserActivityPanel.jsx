import { useMemo, useState } from 'react';
import { Globe } from 'lucide-react';
import {
  deriveStreamingBrowserHint,
  mergeBrowserTimelineRows,
} from '../../../shared/utils/browserActivityTimeline.js';

function runningGlyph(row, streaming) {
  const pending = !!streaming && row.phase === 'running';
  if (pending) return { char: '\u2022', className: 'text-sky-400 animate-pulse' };
  if (row.phase === 'done' && row.ok) return { char: '\u2713', className: 'text-emerald-500' };
  if (row.phase === 'done' && row.ok === false)
    return { char: '\u2715', className: 'text-rose-500' };
  return { char: '\u25CB', className: 'text-gray-500' };
}

/**
 * Browser host steps (`browser_tool_activity` session timeline) plus optional
 * live WebSocket screenshot previews keyed by action id.
 *
 * @param {{ seq?: number, event: object }[]|undefined} props.timelineEntries
 * @param {boolean} props.streaming
 * @param {Record<string, string>|undefined} props.screenshots actionId → data URL
 */
export default function BrowserActivityPanel({ timelineEntries, streaming, screenshots }) {
  const hint = useMemo(() => deriveStreamingBrowserHint(timelineEntries), [timelineEntries]);
  const rows = useMemo(() => mergeBrowserTimelineRows(timelineEntries), [timelineEntries]);
  const hasRunningBrowser = !!(streaming && rows.some((r) => r.phase === 'running'));
  const [open, setOpen] = useState(false);

  if (!hint && rows.length === 0) return null;

  const hasLive = !!(streaming && hint);
  const showDetail = open || hasRunningBrowser;

  return (
    <div className="mt-2 px-1" data-testid="browser-activity-panel">
      {hasLive && (
        <div className="flex items-center gap-2 text-xs text-gray-400 mb-1">
          <Globe size={14} className="shrink-0 text-sky-500/90" aria-hidden />
          <span data-testid="browser-activity-live-hint">{hint}</span>
        </div>
      )}
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1.5 text-xs text-gray-500 hover:text-gray-400 font-medium w-full text-left"
      >
        <Globe size={13} className="shrink-0 text-sky-600/80" aria-hidden />
        <span>Browser Activity{rows.length > 0 ? ` (${rows.length})` : ''}</span>
        {streaming ? <span className="text-[10px] text-gray-600 font-mono">· live</span> : null}
      </button>

      {showDetail ? (
        <ul className="mt-1.5 ml-6 space-y-2 text-[11px] text-gray-400 border-l border-gray-700/80 pl-2 max-h-64 overflow-y-auto">
          {rows.map((row) => {
            const aid = row.actionId;
            const caption =
              row.phase === 'done'
                ? row.summary || row.startedLabel
                : row.startedLabel || row.op || 'Browser';
            const { char, className } = runningGlyph(row, streaming);
            const shot = screenshots?.[aid];
            return (
              <li key={aid} className="leading-snug space-y-1">
                <div className="flex items-start gap-1.5">
                  <span className={`font-mono shrink-0 ${className}`} aria-hidden>
                    {char}
                  </span>
                  <div className="min-w-0 flex-1">
                    <span className="uppercase tracking-wide text-[10px] text-gray-500 mr-2">
                      {row.op || 'browser'}
                    </span>
                    <span>{caption}</span>
                    {row.durationMs != null && row.phase === 'done' ? (
                      <span className="text-gray-600 font-mono text-[10px] ml-2">
                        {row.durationMs}ms
                      </span>
                    ) : null}
                    {row.targetSummary ? (
                      <div className="text-gray-600 font-mono text-[10px] mt-0.5 break-all">
                        {row.targetSummary}
                      </div>
                    ) : null}
                    {row.error ? (
                      <div className="text-rose-400 text-[10px] mt-0.5 break-words">
                        {row.error}
                      </div>
                    ) : null}
                    {row.extractPreview ? (
                      <pre className="text-[10px] text-gray-500 mt-1 whitespace-pre-wrap break-words bg-gray-900/60 rounded px-1.5 py-1 border border-gray-800/80 max-h-28 overflow-y-auto font-mono">
                        {row.extractPreview}
                      </pre>
                    ) : null}
                    {shot ? (
                      <img
                        src={shot}
                        alt="Browser screenshot"
                        className="mt-2 max-w-full max-h-64 rounded border border-gray-700/90 object-contain bg-black/30"
                      />
                    ) : null}
                    {!shot && row.hasScreenshot ? (
                      <div className="text-[10px] text-gray-600 mt-1 italic">
                        Screenshot captured (preview too large or not synced)
                      </div>
                    ) : null}
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}
