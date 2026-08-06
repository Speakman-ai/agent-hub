import { useCallback, useEffect, useState } from 'react';
import { ChevronDown, ChevronRight, Loader2, Radio, Square, XCircle } from 'lucide-react';
import { api } from '../utils/api';
import {
  deriveWatchIndicator,
  watchIndicatorTitle,
  type BackgroundShellView,
} from '../utils/backgroundShells';

/**
 * Live view of a session's Hub-owned background shells.
 *
 * These commands outlive the turn that started them, and a *watched* one will
 * wake the session when it finishes. That makes an idle session with a running
 * shell a normal, expected state — this panel is what tells the human the
 * difference between "waiting on a build" and "died mid-thought", which was
 * previously invisible.
 *
 * Two controls, deliberately distinct: per-shell **Stop** kills one command and
 * still wakes the agent with the result, while **Cancel watch** tears the whole
 * loop down — disarming the wakes *and* killing the processes — for when the
 * human wants the session to stop on its own.
 */
export default function BackgroundShellsPanel({
  sessionId,
  shells,
  onCancelled,
}: {
  sessionId: string;
  shells: BackgroundShellView[];
  onCancelled?: () => void;
}) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [logs, setLogs] = useState<Record<string, string[]>>({});
  const [busyShellId, setBusyShellId] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // A shell that finishes disappears from `shells`; drop its expanded log with
  // it so a later shell reusing the row position doesn't inherit stale output.
  useEffect(() => {
    const live = new Set(shells.map((shell) => shell.id));
    setLogs((prev) => {
      const next: Record<string, string[]> = {};
      for (const [id, lines] of Object.entries(prev)) if (live.has(id)) next[id] = lines;
      return next;
    });
  }, [shells]);

  const loadLogs = useCallback(
    async (shellId: string) => {
      try {
        const body = await api.getBackgroundShellLogs(sessionId, shellId);
        setLogs((prev) => ({ ...prev, [shellId]: body.logs ?? [] }));
      } catch {
        setLogs((prev) => ({ ...prev, [shellId]: ['(failed to load output)'] }));
      }
    },
    [sessionId],
  );

  const toggle = useCallback(
    (shellId: string) => {
      setExpanded((prev) => {
        const open = !prev[shellId];
        if (open) void loadLogs(shellId);
        return { ...prev, [shellId]: open };
      });
    },
    [loadLogs],
  );

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
            ? `${indicator.watching} watched — this session resumes automatically`
            : `${indicator.running} running — not watched`}
        </span>
        {indicator.watching > 0 && (
          <button
            type="button"
            onClick={cancelWatch}
            disabled={cancelling}
            className="ml-auto flex items-center gap-1 rounded-md border border-gray-700 px-2 py-1 text-[11px] text-gray-300 hover:border-red-800/70 hover:bg-red-950/30 hover:text-red-200 disabled:opacity-50"
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
        {shells.map((shell) => {
          const open = Boolean(expanded[shell.id]);
          return (
            <li key={shell.id} className="border-b border-gray-800/60 last:border-b-0">
              <div className="flex items-center gap-2 px-3 py-2">
                <button
                  type="button"
                  onClick={() => toggle(shell.id)}
                  className="flex min-w-0 flex-1 items-center gap-2 text-left text-gray-300 hover:text-white"
                  data-testid={`background-shell-toggle-${shell.id}`}
                >
                  {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                  <span className="truncate font-mono text-[11px]">
                    {shell.label?.trim() || shell.command}
                  </span>
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
              {open && (
                <pre className="max-h-52 overflow-auto whitespace-pre-wrap break-all bg-black/40 px-3 py-2 font-mono text-[10px] text-gray-400">
                  {(logs[shell.id] ?? ['loading…']).join('\n')}
                </pre>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
