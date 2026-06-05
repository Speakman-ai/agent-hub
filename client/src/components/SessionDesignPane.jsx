import { Palette, X, ExternalLink } from 'lucide-react';
import { DesignCanvas } from './DesignView.jsx';

/**
 * SessionDesignPane — live Design Studio canvas embedded beside a regular
 * chat session. Rendered when the active session has a `linked_design_id`
 * that resolves to a known design. Lets the user iterate on the mockup with
 * the agent (in the chat) and watch the canvas update before any code lands.
 *
 * The iframe (DesignCanvas, reused from DesignView) re-fetches whenever
 * `reloadToken` bumps — App.jsx bumps it on every `design_updated` WS event
 * for this design id, so Design Studio edits show up live.
 *
 * Props:
 *   - design:        resolved design row ({ id, name }) — required.
 *   - reloadToken:   number; bump to force the canvas to re-fetch.
 *   - onUnlink():    clear the session↔design link.
 *   - onOpenStudio(): navigate into the full Design Studio view for this design.
 *   - onManualReload(): user-triggered canvas refresh.
 */
export default function SessionDesignPane({
  design,
  reloadToken = 0,
  onUnlink,
  onOpenStudio,
  onManualReload,
}) {
  if (!design) return null;

  return (
    <div
      className="hidden lg:flex flex-col w-[42%] max-w-[640px] min-w-[320px] border-l border-gray-800 bg-gray-950"
      data-testid="session-design-pane"
    >
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
