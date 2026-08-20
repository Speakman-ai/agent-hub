import { AlertTriangle } from 'lucide-react';
import { relativeTime } from '../../../utils/time';

/**
 * Renders the two "Finalize paused" review notices — `finalize_review_stalled`
 * (reviewer engine timed out / quota-dead, an infra stall) and
 * `finalize_review_not_converging` (the reviewer kept requesting changes) — as a
 * styled Finalize row instead of the generic italic system fallback.
 *
 * The server already writes the full plain-English explanation into
 * `message.content`, so this block just frames it. Amber = paused / needs the
 * user, distinct from the red terminal-failure block.
 */
export default function FinalizeReviewNoticeBlock({ message }: any) {
  const content = typeof message?.content === 'string' ? message.content : '';
  return (
    <div className="flex justify-center mb-4" data-testid="finalize-review-notice-block">
      <div className="max-w-[95%] sm:max-w-[80%] w-full border rounded-xl px-4 py-3 border-amber-700/40 bg-amber-950/20">
        <div className="flex items-center gap-2">
          <AlertTriangle className="w-4 h-4 shrink-0 text-amber-300" />
          <p className="text-sm font-medium text-amber-300">Finalize paused</p>
        </div>
        {content ? (
          <p className="text-[12px] text-amber-200/80 mt-1 whitespace-pre-wrap">{content}</p>
        ) : null}
        {message?.created_at ? (
          <div className="text-[11px] text-gray-600 mt-1.5">{relativeTime(message.created_at)}</div>
        ) : null}
      </div>
    </div>
  );
}
