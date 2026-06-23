import { useCallback, useState } from 'react';
import { Palette, Download, GripVertical } from 'lucide-react';
import { DesignCanvas } from './DesignView';
import { exportDesignPdf } from '../utils/exportDesignPdf';
import { getServerBase } from '../utils/connection';
import { useResizablePaneWidth } from '../hooks/useResizablePaneWidth';
import {
  designPaneWidthStorageKey,
  DEFAULT_DESIGN_PANE_WIDTH,
  MIN_DESIGN_PANE_WIDTH,
  MAX_DESIGN_PANE_WIDTH,
} from '../utils/sessionPreviewState';

/**
 * SessionDesignModePane — live canvas for a session running in `session_mode =
 * 'design'`. Unlike SessionDesignPane (which embeds a *linked* standalone Design
 * Studio design via `/design-files/<designId>/`), this renders the artifacts the
 * agent writes into the session's own worktree `design/` dir, served from the
 * `/session-files/<sessionId>/design/` mount. Because the files live in the
 * worktree, flipping the session back to `chat`/Build hands them over for free.
 */
export default function SessionDesignModePane({
  sessionId,
  reloadToken = 0,
  busy = false,
  onManualReload,
}: any) {
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<any>(null);

  const { width, isResizing, handleProps } = useResizablePaneWidth({
    storageKey: designPaneWidthStorageKey(sessionId, 'mode'),
    defaultWidth: DEFAULT_DESIGN_PANE_WIDTH,
    min: MIN_DESIGN_PANE_WIDTH,
    max: MAX_DESIGN_PANE_WIDTH,
  });

  const handleDownloadPdf = useCallback(async () => {
    if (!sessionId || exporting || busy) return;
    setExporting(true);
    setExportError(null);
    try {
      await exportDesignPdf({
        designId: `session-${sessionId}`,
        base: getServerBase(),
        srcBase: `/session-files/${encodeURIComponent(sessionId)}/design`,
        filename: `design-${sessionId}`,
      });
    } catch (err: any) {
      setExportError(err?.message || 'Failed to export PDF');
    } finally {
      setExporting(false);
    }
  }, [sessionId, exporting, busy]);

  if (!sessionId) return null;

  return (
    <div
      className={`hidden lg:flex flex-col shrink-0 border-l border-gray-800 bg-gray-950 relative ${
        isResizing ? 'select-none' : ''
      }`}
      style={{ width: `${width}px` }}
      data-testid="session-design-mode-pane"
    >
      <div
        {...handleProps}
        aria-label="Resize design pane"
        title="Drag to resize design pane"
        className={`absolute top-0 left-0 z-20 flex h-full w-3 -translate-x-1/2 cursor-col-resize touch-none items-center justify-center transition-colors focus:outline-none focus-visible:bg-sky-500/50 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-sky-400 ${
          isResizing ? 'bg-sky-500/50' : 'bg-gray-800/80 hover:bg-sky-500/35'
        }`}
        data-testid="session-design-mode-pane-resize-handle"
      >
        <GripVertical
          size={14}
          className={`text-gray-500 ${isResizing ? 'text-sky-200' : 'hover:text-sky-300'}`}
          aria-hidden
        />
      </div>
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
