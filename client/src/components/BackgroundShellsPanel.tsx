import { useCallback, useState } from 'react';
import { Loader2, Radio, Square, SquareTerminal, XCircle } from 'lucide-react';
import { api } from '../utils/api';
import {
  deriveWatchIndicator,
  terminalJobLabel,
  watchIndicatorTitle,
  type BackgroundShellView,
} from '../utils/backgroundShells';

/**
 * Compact status for Hub-owned background shells.
 *
 * Live output belongs in the Terminal job tab — this panel is the chat-side
 * reminder that the session is waiting on a command, plus Stop / Cancel watch.
 */
export default function BackgroundShellsPanel({
  sessionId,
  shells,
  onCancelled,
  onOpenTerminal,
}: {
  sessionId: string;
  shells: BackgroundShellView[];
  onCancelled?: () => void;
  onOpenTerminal?: (shellId?: string) => void;
}) {
  const [busyShellId, setBusyShellId] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const stopShell = useCallback(
    async (shellId: string) => {
      setBusyShellId(shellId);
      setError(null);
      try {
        await api.stopBackgroundShell(sessionId, shellId);
      } catch {
        setError('Failed to stop the shell.');
      } finally {
        setBusyShellId(null);
      }
    },
    [sessionId],
  );

  const cancelWatch = useCallback(async () => {
    setCancelling(true);
    setError(null);
    try {
      await api.cancelBackgroundShellWatch(sessionId);
      onCancelled?.();
    } catch {
      setError('Failed to cancel the watch loop.');
    } finally {
      setCancelling(false);
    }
  }, [sessionId, onCancelled]);

  const indicator = deriveWatchIndicator(shells);
  if (!indicator) return null;

  return (
    <div
      className="rounded-lg border border-gray-800 bg-gray-900/60 text-xs"
      data-testid="background-shells-panel"
    >
      <div className="flex items-center gap-2 border-b border-gray-800 px-3 py-2">
        <Radio
          size={13}
          className={indicator.watching > 0 ? 'text-amber-400 animate-pulse' : 'text-gray-500'}
        />
        <span className="font-medium text-gray-200">Background shells</span>
        <span className="text-gray-500" title={watchIndicatorTitle(indicator)}>
          {indicator.watching > 0
            ? `${indicator.watching} watched — live output is in the Terminal`
            : `${indicator.running} running — live output is in the Terminal`}
        </span>
        {onOpenTerminal && (
          <button
            type="button"
            onClick={() => onOpenTerminal()}
            className="ml-auto flex items-center gap-1 rounded-md border border-gray-700 px-2 py-1 text-[11px] text-gray-300 hover:border-cyan-800/70 hover:bg-cyan-950/30 hover:text-cyan-200"
            title="Open the Terminal pane"
            data-testid="background-shells-open-terminal"
          >
            <SquareTerminal size={12} />
            Open Terminal
          </button>
        )}
        {indicator.watching > 0 && (
          <button
            type="button"
            onClick={cancelWatch}
            disabled={cancelling}
            className={`${onOpenTerminal ? '' : 'ml-auto'} flex items-center gap-1 rounded-md border border-gray-700 px-2 py-1 text-[11px] text-gray-300 hover:border-red-800/70 hover:bg-red-950/30 hover:text-red-200 disabled:opacity-50`}
            title="Stop watching and terminate these background shells"
            data-testid="background-shells-cancel-watch"
          >
            {cancelling ? <Loader2 size={12} className="animate-spin" /> : <XCircle size={12} />}
            Cancel watch
          </button>
        )}
      </div>

      {error && (
        <div className="border-b border-gray-800 px-3 py-1.5 text-[11px] text-red-300">{error}</div>
      )}

      <ul>
        {shells.map((shell) => (
          <li key={shell.id} className="border-b border-gray-800/60 last:border-b-0">
            <div className="flex items-center gap-2 px-3 py-2">
              <button
                type="button"
                onClick={() => onOpenTerminal?.(shell.id)}
                className="flex min-w-0 flex-1 items-center gap-2 text-left text-gray-300 hover:text-white"
                data-testid={`background-shell-open-${shell.id}`}
                title="Show live output in the Terminal"
              >
                <span className="truncate font-mono text-[11px]">{terminalJobLabel(shell)}</span>
                {shell.watch === 1 && (
                  <span className="flex-shrink-0 rounded bg-amber-950/50 px-1.5 py-0.5 text-[9px] text-amber-300">
                    watched
                  </span>
                )}
              </button>
              <button
                type="button"
                onClick={() => stopShell(shell.id)}
                disabled={busyShellId === shell.id}
                className="flex flex-shrink-0 items-center gap-1 rounded-md border border-gray-700 px-1.5 py-0.5 text-[10px] text-gray-400 hover:border-gray-600 hover:text-gray-200 disabled:opacity-50"
                title="Stop this shell"
                data-testid={`background-shell-stop-${shell.id}`}
              >
                {busyShellId === shell.id ? (
                  <Loader2 size={10} className="animate-spin" />
                ) : (
                  <Square size={10} />
                )}
                Stop
              </button>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
