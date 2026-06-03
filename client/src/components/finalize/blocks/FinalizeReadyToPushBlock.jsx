import { Upload } from 'lucide-react';
import { parseFinalizeReadyToPushMetadata } from '../../../utils/finalizeTimeline.js';
import { shortSha } from '../../../utils/prMessage.js';
import { relativeTime } from '../../../utils/time.js';

export default function FinalizeReadyToPushBlock({ message }) {
  const meta = parseFinalizeReadyToPushMetadata(message.metadata);
  if (!meta) return null;

  return (
    <div className="flex justify-center mb-4" data-testid="finalize-ready-to-push-block">
      <div className="max-w-[95%] sm:max-w-[80%] w-full bg-emerald-950/25 border border-emerald-700/40 rounded-xl px-4 py-3">
        <div className="flex items-center gap-2">
          <Upload className="w-4 h-4 text-emerald-400 shrink-0" />
          <div>
            <p className="text-sm font-medium text-emerald-200">Ready to push to GitHub</p>
            {meta.validatedHeadSha ? (
              <p className="text-xs text-emerald-200/70 mt-0.5">
                Validated{' '}
                <code className="text-[10px] bg-gray-900/60 px-1 rounded">
                  {shortSha(meta.validatedHeadSha)}
                </code>
              </p>
            ) : null}
          </div>
        </div>
        {message.created_at ? (
          <div className="text-[11px] text-gray-600 mt-1.5">{relativeTime(message.created_at)}</div>
        ) : null}
      </div>
    </div>
  );
}
