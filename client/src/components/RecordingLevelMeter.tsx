import { AlertTriangle } from 'lucide-react';
import { silenceWarningMessage } from '@shared/utils/audioLevel';
import { useAudioLevel } from '../hooks/useAudioLevel';

const BARS = 5;

/**
 * Live view of what the recorder hears: a small level meter, plus a warning
 * when the input has been silent long enough that the take is likely empty.
 */
export default function RecordingLevelMeter({
  stream,
  showWarning = true,
}: {
  stream: MediaStream | null;
  showWarning?: boolean;
}) {
  const { level, warning } = useAudioLevel(stream);
  const lit = Math.round(level * BARS);
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5">
      <span
        role="meter"
        aria-label="Microphone level"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(level * 100)}
        className="flex h-3 shrink-0 items-end gap-px"
        data-testid="recording-level-meter"
      >
        {Array.from({ length: BARS }, (_, i) => (
          <span
            key={i}
            className={`w-0.5 rounded-sm ${i < lit ? (warning ? 'bg-amber-400' : 'bg-green-400') : 'bg-gray-600'}`}
            style={{ height: `${40 + i * 15}%` }}
          />
        ))}
      </span>
      {showWarning && warning && (
        <span
          role="alert"
          className="flex min-w-0 items-center gap-1 text-xs text-amber-400"
          data-testid="recording-silence-warning"
        >
          <AlertTriangle size={12} className="shrink-0" />
          <span className="min-w-0">{silenceWarningMessage(warning)}</span>
        </span>
      )}
    </span>
  );
}
