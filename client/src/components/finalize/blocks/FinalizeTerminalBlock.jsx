import { CheckCircle2, XCircle, AlertTriangle } from 'lucide-react';
import { parseFinalizeTerminalMetadata } from '../../../utils/finalizeTimeline.js';
import { relativeTime } from '../../../utils/time.js';

function labelForStatus(status, failureReason) {
  switch (status) {
    case 'pushed':
      return 'Pushed to GitHub';
    case 'cancelled':
      return 'Cancelled';
    case 'ready_to_push':
      return 'Ready to push';
    case 'timed_out':
      return 'Timed out';
    case 'stalled_no_response':
      return 'Stalled — no response';
    default:
      return failureReason ? `Failed (${failureReason})` : `Ended (${status})`;
  }
}

export default function FinalizeTerminalBlock({ message }) {
  const meta = parseFinalizeTerminalMetadata(message.metadata);
  if (!meta) return null;

  const isSuccess = meta.status === 'pushed' || meta.status === 'ready_to_push';
  const isWarn = meta.status === 'stalled_no_response';
  const Icon = isSuccess ? CheckCircle2 : isWarn ? AlertTriangle : XCircle;
  const tone = isSuccess ? 'text-emerald-300' : isWarn ? 'text-amber-300' : 'text-red-300';
  const border = isSuccess
    ? 'border-emerald-700/40 bg-emerald-950/20'
    : isWarn
      ? 'border-amber-700/40 bg-amber-950/20'
      : 'border-red-700/40 bg-red-950/20';

  return (
    <div className="flex justify-center mb-4" data-testid="finalize-terminal-block">
      <div className={`max-w-[95%] sm:max-w-[80%] w-full border rounded-xl px-4 py-3 ${border}`}>
        <div className="flex items-center gap-2">
          <Icon className={`w-4 h-4 shrink-0 ${tone}`} />
          <p className={`text-sm font-medium ${tone}`}>
            {labelForStatus(meta.status, meta.failureReason)}
          </p>
        </div>
        {message.created_at ? (
          <div className="text-[11px] text-gray-600 mt-1.5">{relativeTime(message.created_at)}</div>
        ) : null}
      </div>
    </div>
  );
}
