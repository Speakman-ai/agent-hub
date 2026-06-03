import { Wrench } from 'lucide-react';
import { parseFinalizeFixDispatchMetadata } from '../../../utils/finalizeTimeline.js';
import { relativeTime } from '../../../utils/time.js';

export default function FinalizeFixDispatchBlock({ message }) {
  const meta = parseFinalizeFixDispatchMetadata(message.metadata);
  if (!meta) return null;

  const parts = [];
  if (meta.failedStepName) parts.push(`CI: ${meta.failedStepName} failed`);
  if (meta.reviewerVerdict === 'changes_requested') {
    parts.push(
      meta.reviewerThreadCount > 0
        ? `Review: ${meta.reviewerThreadCount} finding${meta.reviewerThreadCount === 1 ? '' : 's'}`
        : 'Review: changes requested',
    );
  }

  return (
    <div className="flex justify-center mb-4" data-testid="finalize-fix-dispatch-block">
      <div className="max-w-[95%] sm:max-w-[90%] w-full bg-amber-950/25 border border-amber-700/40 rounded-xl px-4 py-3">
        <div className="flex items-start gap-2">
          <Wrench className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
          <div className="min-w-0">
            <p className="text-sm font-medium text-amber-200">Fix round dispatched</p>
            {parts.length > 0 ? (
              <p className="text-xs text-amber-200/70 mt-0.5">{parts.join(' · ')}</p>
            ) : null}
            {message.content ? (
              <p className="text-xs text-slate-300 mt-2 whitespace-pre-wrap">{message.content}</p>
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
