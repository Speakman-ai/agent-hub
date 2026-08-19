import { useState } from 'react';
import { Monitor, Loader2, Settings2, ChevronDown, Hammer, RefreshCw } from 'lucide-react';
import { isPreviewConfigured, hasDevServerBuildCommand } from '../utils/sessionPreviewState';
import {
  sessionActionControlClass,
  sessionActionSubmenuClass,
  type SessionActionControlVariant,
} from '../utils/sessionActionMenu';

/** Start path for the preview boot — mirrors the server `mode` param. */
export type PreviewStartMode = 'rebuild' | 'restart-server';

/**
 * Toolbar control to boot the session worktree preview (POST .../preview/start).
 *
 * When a preview is already running AND the project configures a
 * `buildCommand`, the button becomes a split dropdown: "Restart Server"
 * (skip the build, recycle only the server process) and "Rebuild App"
 * (re-run the build first). Without a build command both are identical, so
 * the control stays a single button.
 */
export default function SessionPreviewStartButton({
  sessionId,
  project,
  previewEvent,
  disabled,
  starting,
  workspaceEnsuring,
  workspaceNotReady,
  onStart,
  onConfigure,
  variant = 'toolbar',
}: {
  variant?: SessionActionControlVariant;
  [key: string]: any;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const configured = isPreviewConfigured(project);
  const kind = previewEvent?.kind;
  const busy = starting || kind === 'preview_starting';
  const isMenu = variant === 'menu';
  const running = kind === 'preview';
  const hasBuild = hasDevServerBuildCommand(project);

  if (!configured) {
    return (
      <button
        type="button"
        onClick={onConfigure}
        disabled={disabled || !onConfigure}
        className={sessionActionControlClass(
          variant,
          isMenu
            ? 'text-amber-200'
            : 'text-amber-200/90 hover:text-amber-100 border-amber-800/50 bg-amber-950/30',
        )}
        data-testid="session-preview-configure-button"
      >
        <Settings2 size={14} />
        Configure preview
      </button>
    );
  }

  const controlDisabled = Boolean(
    disabled || busy || workspaceEnsuring || workspaceNotReady || !sessionId,
  );
  const title = workspaceEnsuring
    ? 'Cloning the session worktree — preview will be available when this finishes'
    : workspaceNotReady
      ? 'Waiting for the session worktree'
      : undefined;
  const primaryClass = sessionActionControlClass(
    variant,
    isMenu
      ? 'text-sky-200'
      : 'font-medium text-sky-200 hover:text-white border-sky-700/60 bg-sky-950/40 hover:bg-sky-900/50 disabled:opacity-50',
  );

  // Running + a build step configured → split the action into Rebuild App
  // (run the build first) and Restart Server (reuse the last build).
  if (running && hasBuild) {
    const pick = (mode: PreviewStartMode) => {
      setMenuOpen(false);
      onStart?.(sessionId, mode);
    };
    return (
      <div className={isMenu ? 'relative w-full' : 'relative inline-flex'}>
        <button
          type="button"
          onClick={() => setMenuOpen((v) => !v)}
          disabled={controlDisabled}
          title={title}
          className={primaryClass}
          data-testid="session-restart-preview-menu-button"
          aria-haspopup="menu"
          aria-expanded={menuOpen}
        >
          {busy ? <Loader2 size={14} className="animate-spin" /> : <Monitor size={14} />}
          {busy ? 'Starting preview…' : 'Restart preview'}
          <ChevronDown size={14} />
        </button>
        {menuOpen && (
          <>
            {/* Toolbar variant: a full-screen click-away backdrop. In the
                menu variant the flyout renders in normal flow inside the
                already-open Actions dropdown (which owns outside-click), so a
                `fixed inset-0` backdrop there would swallow every click on the
                rest of the menu — omit it. */}
            {!isMenu && (
              <button
                type="button"
                aria-hidden="true"
                tabIndex={-1}
                className="fixed inset-0 z-10 cursor-default"
                onClick={() => setMenuOpen(false)}
              />
            )}
            <div
              role="menu"
              // Menu variant renders in-flow (the Actions dropdown is
              // `overflow-y-auto`, which clips an `absolute top-full` flyout —
              // same reason `SessionBranchPicker` uses this helper).
              className={sessionActionSubmenuClass(
                variant,
                'absolute right-0 top-full z-20 mt-1 min-w-[13rem] rounded-md border border-gray-700 bg-gray-900 p-1 shadow-xl',
              )}
            >
              <button
                type="button"
                role="menuitem"
                onClick={() => pick('restart-server')}
                className="flex w-full items-start gap-2 rounded px-2 py-1.5 text-left text-xs text-gray-200 hover:bg-gray-800"
                data-testid="session-preview-restart-server"
              >
                <RefreshCw size={14} className="mt-0.5 shrink-0 text-sky-300" />
                <span>
                  <span className="block font-medium">Restart Server</span>
                  <span className="block text-[11px] text-gray-500">
                    Recycle the server, reuse the last build
                  </span>
                </span>
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={() => pick('rebuild')}
                className="flex w-full items-start gap-2 rounded px-2 py-1.5 text-left text-xs text-gray-200 hover:bg-gray-800"
                data-testid="session-preview-rebuild-app"
              >
                <Hammer size={14} className="mt-0.5 shrink-0 text-amber-300" />
                <span>
                  <span className="block font-medium">Rebuild App</span>
                  <span className="block text-[11px] text-gray-500">
                    Run the build command, then restart
                  </span>
                </span>
              </button>
            </div>
          </>
        )}
      </div>
    );
  }

  const label = workspaceEnsuring
    ? 'Preparing workspace…'
    : busy
      ? 'Starting preview…'
      : running
        ? 'Restart preview'
        : 'Start preview';

  return (
    <button
      type="button"
      onClick={() => onStart?.(sessionId, 'rebuild')}
      disabled={controlDisabled}
      title={title}
      className={primaryClass}
      data-testid="session-start-preview-button"
    >
      {busy ? <Loader2 size={14} className="animate-spin" /> : <Monitor size={14} />}
      {label}
    </button>
  );
}
