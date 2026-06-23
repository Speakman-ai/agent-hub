import { Palette, X, ExternalLink, GripVertical } from 'lucide-react';
import { DesignCanvas } from './DesignView';
import { useResizablePaneWidth } from '../hooks/useResizablePaneWidth';
import {
  designPaneWidthStorageKey,
  DEFAULT_DESIGN_PANE_WIDTH,
  MIN_DESIGN_PANE_WIDTH,
  MAX_DESIGN_PANE_WIDTH,
} from '../utils/sessionPreviewState';

/**
 * SessionDesignPane — live Design Studio canvas embedded beside a regular
 * chat session. Rendered when the active session has a `linked_design_id`
 * that resolves to a known design.
 */
export default function SessionDesignPane({
  sessionId,
  design,
  reloadToken = 0,
  onUnlink,
  onOpenStudio,
  onManualReload,
}: any) {
  const { width, isResizing, handleProps } = useResizablePaneWidth({
    storageKey: designPaneWidthStorageKey(sessionId, 'linked'),
    defaultWidth: DEFAULT_DESIGN_PANE_WIDTH,
    min: MIN_DESIGN_PANE_WIDTH,
    max: MAX_DESIGN_PANE_WIDTH,
  });

  if (!design) return null;

  return (
    <div
      className={`hidden lg:flex flex-col shrink-0 border-l border-gray-800 bg-gray-950 relative ${
        isResizing ? 'select-none' : ''
      }`}
      style={{ width: `${width}px` }}
      data-testid="session-design-pane"
    >
      <div
        {...handleProps}
        aria-label="Resize design pane"
        title="Drag to resize design pane"
        className={`absolute top-0 left-0 z-20 flex h-full w-3 -translate-x-1/2 cursor-col-resize touch-none items-center justify-center transition-colors focus:outline-none focus-visible:bg-sky-500/50 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-sky-400 ${
          isResizing ? 'bg-sky-500/50' : 'bg-gray-800/80 hover:bg-sky-500/35'
        }`}
        data-testid="session-design-pane-resize-handle"
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
          <span className="text-xs font-semibold text-gray-200 truncate" title={design.name}>
            {design.name}
          </span>
          <span className="text-[10px] uppercase tracking-wider text-gray-600 flex-shrink-0">
            Linked design
          </span>
        </div>
        <div className="flex items-center gap-1 flex-shrink-0">
          {onOpenStudio && (
            <button
              type="button"
              onClick={onOpenStudio}
              className="flex items-center gap-1 text-[11px] text-gray-400 hover:text-gray-100 border border-gray-700 hover:border-gray-500 rounded-md px-2 py-1 transition-colors"
              title="Open this design in Design Studio"
              data-testid="session-design-open-studio"
            >
              <ExternalLink size={12} />
              <span className="hidden xl:inline">Studio</span>
            </button>
          )}
          {onUnlink && (
            <button
              type="button"
              onClick={onUnlink}
              className="text-gray-500 hover:text-red-400 transition-colors p-1"
              title="Unlink this design from the session"
              aria-label="Unlink design"
              data-testid="session-design-unlink"
            >
              <X size={15} />
            </button>
          )}
        </div>
      </div>
      <DesignCanvas
        designId={design.id}
        reloadToken={reloadToken}
        onManualReload={onManualReload}
      />
    </div>
  );
}
