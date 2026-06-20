import { Palette } from 'lucide-react';
import { DesignCanvas } from './DesignView.jsx';

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
 * Props:
 *   - sessionId:      session whose worktree design/ dir to render — required.
 *   - reloadToken:    number; bump to force the canvas to re-fetch.
 *   - onManualReload(): user-triggered canvas refresh.
 */
export default function SessionDesignModePane({ sessionId, reloadToken = 0, onManualReload }) {
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
      </div>
      <DesignCanvas
        designId={`session-${sessionId}`}
        srcBase={`/session-files/${sessionId}/design`}
        reloadToken={reloadToken}
        onManualReload={onManualReload}
      />
    </div>
  );
}
