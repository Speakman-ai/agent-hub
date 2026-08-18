import { Monitor, Loader2, Settings2 } from 'lucide-react';
import { isPreviewConfigured } from '../utils/sessionPreviewState';
import {
  sessionActionControlClass,
  type SessionActionControlVariant,
} from '../utils/sessionActionMenu';

/**
 * Toolbar control to boot the session worktree preview (POST .../preview/start).
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
  const configured = isPreviewConfigured(project);
  const kind = previewEvent?.kind;
  const busy = starting || kind === 'preview_starting';
  const isMenu = variant === 'menu';

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

  const label = workspaceEnsuring
    ? 'Preparing workspace…'
    : busy
      ? 'Starting preview…'
      : kind === 'preview'
        ? 'Restart preview'
        : 'Start preview';

  return (
    <button
      type="button"
      onClick={() => onStart?.(sessionId)}
      disabled={disabled || busy || workspaceEnsuring || workspaceNotReady || !sessionId}
      title={
        workspaceEnsuring
          ? 'Cloning the session worktree — preview will be available when this finishes'
          : workspaceNotReady
            ? 'Waiting for the session worktree'
            : undefined
      }
      className={sessionActionControlClass(
        variant,
        isMenu
          ? 'text-sky-200'
          : 'font-medium text-sky-200 hover:text-white border-sky-700/60 bg-sky-950/40 hover:bg-sky-900/50 disabled:opacity-50',
      )}
      data-testid="session-start-preview-button"
    >
      {busy ? <Loader2 size={14} className="animate-spin" /> : <Monitor size={14} />}
      {label}
    </button>
  );
}
