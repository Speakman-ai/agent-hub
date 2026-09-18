import { useState } from 'react';
import { RotateCcw } from 'lucide-react';
import { api } from '../../utils/api';
import { SESSION_ACTION_TOOLBAR_BUTTON_CLASS } from '../../utils/sessionActionMenu';

export default function AutopilotUnstickButton({
  sessionId,
  disabled = false,
  onStarted,
  onError,
}: {
  sessionId: string;
  disabled?: boolean;
  onStarted?: () => void;
  onError?: (message: string) => void;
}) {
  const [busy, setBusy] = useState(false);

  const handleClick = async () => {
    if (!sessionId || busy || disabled) return;
    setBusy(true);
    onStarted?.();
    try {
      await api.unstickSessionAutopilot(sessionId);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Failed to unstick Autopilot';
      onError?.(message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <button
      type="button"
      data-testid="autopilot-unstick-button"
      title="Stop the hung turn, cancel CI, and continue Autopilot from here"
      disabled={busy || disabled}
      onClick={() => void handleClick()}
      className={`${SESSION_ACTION_TOOLBAR_BUTTON_CLASS} border-amber-700/60 bg-amber-950/40 text-amber-100 hover:bg-amber-900/50 disabled:opacity-50 disabled:cursor-not-allowed`}
    >
      <RotateCcw size={14} className={`shrink-0 ${busy ? 'animate-spin' : ''}`} aria-hidden />
      <span className="font-medium">{busy ? 'Unsticking…' : 'Unstick'}</span>
    </button>
  );
}
