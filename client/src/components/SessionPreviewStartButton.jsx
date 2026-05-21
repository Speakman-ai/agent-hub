import { Monitor, Loader2, Settings2 } from 'lucide-react';
import { isPreviewConfigured } from './PreviewSection.jsx';

/**
 * Toolbar control to boot the session worktree preview (POST .../preview/start).
 */
export default function SessionPreviewStartButton({
  sessionId,
  project,
  previewEvent,
  disabled,
  starting,
  onStart,
  onConfigure,
}) {
  const configured = isPreviewConfigured(project);
  const kind = previewEvent?.kind;
  const busy = starting || kind === 'preview_starting';

  if (!configured) {
    return (
      <button
        type="button"
        onClick={onConfigure}
        disabled={disabled || !onConfigure}
        className="inline-flex items-center gap-1.5 text-xs text-amber-200/90 hover:text-amber-100 border border-amber-800/50 rounded-lg px-2.5 py-1.5 bg-amber-950/30"
        data-testid="session-preview-configure-button"
      >
        <Settings2 size={14} />
        Configure preview
      </button>
    );
  }

  const label = busy
    ? 'Starting preview…'
    : kind === 'preview'
      ? 'Restart preview'
      : 'Start preview';

  return (
    <button
      type="button"
      onClick={() => onStart?.(sessionId)}
      disabled={disabled || busy || !sessionId}
      className="inline-flex items-center gap-1.5 text-xs font-medium text-sky-200 hover:text-white border border-sky-700/60 rounded-lg px-2.5 py-1.5 bg-sky-950/40 hover:bg-sky-900/50 disabled:opacity-50"
      data-testid="session-start-preview-button"
    >
      {busy ? <Loader2 size={14} className="animate-spin" /> : <Monitor size={14} />}
      {label}
    </button>
  );
}
