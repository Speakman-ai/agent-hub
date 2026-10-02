import { useEffect, useState } from 'react';
import { Copy, Loader2, Square, X } from 'lucide-react';
import { useNoteRecording } from './NoteRecordingProvider';

export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

/**
 * Floating status for a notes voice take that outlived its editor (the user
 * left the Notes page or opened another note). Shows the mic is live and
 * gives a Stop button; the result is saved to the note it was recorded for.
 */
export default function NoteRecordingWidget({
  onOpenNotes,
}: {
  onOpenNotes?: (projectId: string) => void;
}) {
  const recording = useNoteRecording();
  const [now, setNow] = useState(() => Date.now());
  const live = !!recording && !recording.attached && recording.isRecording;

  useEffect(() => {
    if (!live) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [live]);

  if (!recording || recording.attached) return null;
  const { isRecording, isTranscribing, summarizing, saving, target, error, unsavedBlock } =
    recording;
  const busy = isTranscribing || summarizing || saving;
  if (!isRecording && !busy && !error) return null;

  const noteLabel = target?.title && target.title !== 'Untitled' ? target.title : 'New note';
  const status = isRecording
    ? 'Recording note'
    : isTranscribing
      ? 'Transcribing…'
      : summarizing
        ? 'Summarizing…'
        : saving
          ? 'Saving to note…'
          : '';

  return (
    <div
      role="status"
      aria-label="Note recording"
      className="fixed top-3 left-1/2 z-[60] flex w-max max-w-[min(24rem,calc(100vw-2rem))] -translate-x-1/2 items-center gap-3 rounded-lg border border-gray-700 bg-gray-900/95 px-3 py-2 text-sm text-gray-200 shadow-lg"
    >
      {error ? (
        <>
          <span className="min-w-0 flex-1 text-xs text-red-400">{error}</span>
          {unsavedBlock && (
            <button
              onClick={() => void navigator.clipboard?.writeText(unsavedBlock)}
              className="rounded p-1 text-gray-400 hover:text-gray-200"
              title="Copy the recording text"
              aria-label="Copy recording text"
            >
              <Copy size={14} />
            </button>
          )}
          <button
            onClick={recording.dismissError}
            className="rounded p-1 text-gray-400 hover:text-gray-200"
            title="Dismiss"
            aria-label="Dismiss"
          >
            <X size={14} />
          </button>
        </>
      ) : (
        <>
          {isRecording ? (
            <span className="h-2.5 w-2.5 shrink-0 animate-pulse rounded-full bg-red-500" />
          ) : (
            <Loader2 size={14} className="shrink-0 animate-spin text-blue-400" />
          )}
          <button
            onClick={() => target && onOpenNotes?.(target.projectId)}
            disabled={!onOpenNotes || !target}
            className="min-w-0 flex-1 text-left disabled:cursor-default"
            title={onOpenNotes ? 'Open notes' : undefined}
          >
            <span className="block text-xs font-medium">
              {status}
              {isRecording && recording.startedAt != null && (
                <span className="ml-1.5 tabular-nums text-gray-400">
                  {formatElapsed(now - recording.startedAt)}
                </span>
              )}
            </span>
            <span className="block truncate text-xs text-gray-400">{noteLabel}</span>
          </button>
          {isRecording && (
            <button
              onClick={recording.stop}
              className="flex items-center gap-1 rounded bg-red-600 px-2 py-1 text-xs font-medium text-white hover:bg-red-500"
              aria-label="Stop recording"
            >
              <Square size={10} fill="currentColor" />
              Stop
            </button>
          )}
        </>
      )}
    </div>
  );
}
