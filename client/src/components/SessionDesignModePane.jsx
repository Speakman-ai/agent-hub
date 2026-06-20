import { useCallback, useState } from 'react';
import { Palette, Download } from 'lucide-react';
import { DesignCanvas } from './DesignView.jsx';
import { exportDesignPdf } from '../utils/exportDesignPdf.js';
import { getServerBase } from '../utils/connection.js';

/**
 * SessionDesignModePane — live canvas for a session running in `session_mode =
 * 'design'`. Unlike SessionDesignPane (which embeds a *linked* standalone Design
 * Studio design via `/design-files/<designId>/`), this renders the artifacts the
 * agent writes into the session's own worktree `design/` dir, served from the
 * `/session-files/<sessionId>/design/` mount. Because the files live in the
 * worktree, flipping the session back to `chat`/Build hands them over for free.
 *
 * The DesignCanvas iframe re-fetches whenever `reloadToken` bumps — App.jsx
 * bumps it on `code_changed` / turn-`done` for this session, so the agent's
 * file writes show up on the canvas without a manual refresh.
 *
 * PDF export reuses the same `exportDesignPdf` util the standalone Design Studio
 * uses — we just point it at the session's worktree mount via `srcBase`. The
 * Electron native-save path (`window.electronAPI.saveDesignPdf`) inside that
 * util is engine-agnostic, so desktop gets the OS save dialog with no extra
 * wiring (card 1028: Electron parity + PDF export reuse).
 *
 * Props:
 *   - sessionId:      session whose worktree design/ dir to render — required.
 *   - reloadToken:    number; bump to force the canvas to re-fetch.
 *   - busy:           true while the agent is streaming/writing — disables PDF
 *                     export so the capture reflects a stable index.html.
 *   - onManualReload(): user-triggered canvas refresh.
 */
export default function SessionDesignModePane({
  sessionId,
  reloadToken = 0,
  busy = false,
  onManualReload,
}) {
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState(null);

  const handleDownloadPdf = useCallback(async () => {
    if (!sessionId || exporting || busy) return;
    setExporting(true);
    setExportError(null);
    try {
      await exportDesignPdf({
        designId: `session-${sessionId}`,
        base: getServerBase(),
        // Encode the id segment: session ids can carry URL-significant chars
        // (`#`, `?`, spaces, `/`) and `srcBase` is interpolated raw into the
        // fetch URL, so a literal id would resolve to the wrong artifact path.
        srcBase: `/session-files/${encodeURIComponent(sessionId)}/design`,
        filename: `design-${sessionId}`,
      });
    } catch (err) {
      setExportError(err?.message || 'Failed to export PDF');
    } finally {
      setExporting(false);
    }
  }, [sessionId, exporting, busy]);

  if (!sessionId) return null;

  return (
    <div
      className="hidden lg:flex flex-col w-[42%] max-w-[640px] min-w-[320px] border-l border-gray-800 bg-gray-950"
      data-testid="session-design-mode-pane"
    >
      <div className="border-b border-gray-800 px-3 py-2 flex items-center justify-between flex-shrink-0 gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <Palette size={15} className="text-purple-400 flex-shrink-0" />
          <span className="text-xs font-semibold text-gray-200 truncate">Design canvas</span>
          <span className="text-[10px] uppercase tracking-wider text-gray-600 flex-shrink-0">
            Design mode
          </span>
        </div>
        <div className="flex items-center gap-2 min-w-0">
          {exportError && (
            <span className="text-xs text-red-400 hidden xl:inline truncate" title={exportError}>
              {exportError}
            </span>
          )}
          <button
            type="button"
            onClick={handleDownloadPdf}
            disabled={exporting || busy}
            className="flex items-center gap-1 text-xs text-gray-300 hover:text-white disabled:opacity-40 disabled:cursor-not-allowed transition-colors flex-shrink-0"
            title={
              busy
                ? 'Wait for the agent to finish before exporting'
                : 'Download this design as a PDF'
            }
            aria-label="Download design as PDF"
            data-testid="session-design-export-pdf"
          >
            <Download size={14} />
            <span className="hidden sm:inline">{exporting ? 'Exporting…' : 'PDF'}</span>
          </button>
        </div>
      </div>
      <DesignCanvas
        designId={`session-${sessionId}`}
        srcBase={`/session-files/${encodeURIComponent(sessionId)}/design`}
        reloadToken={reloadToken}
        onManualReload={onManualReload}
      />
    </div>
  );
}
