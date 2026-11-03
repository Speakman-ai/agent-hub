import { MessageSquareWarning } from 'lucide-react';
import {
  formatReviewDisputeLocation,
  type ExtractedReviewDisputeBlock,
} from '@shared/utils/extractReviewDisputeBlocks';

/**
 * Card for an `<agenthub:review-dispute>` block: the agent's pushback on
 * Finalize review findings, one row per disputed file and line range.
 */
export default function ReviewDisputeCard({ block }: { block: ExtractedReviewDisputeBlock }) {
  const { disputes, raw, partial } = block;
  const count = disputes.length;
  const title = partial
    ? 'Disputing review findings…'
    : count > 0
      ? `Disputed ${count} review finding${count === 1 ? '' : 's'}`
      : 'Review dispute';
  return (
    <div
      data-testid="review-dispute-card"
      className="mt-2 rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-sm"
    >
      <div className="flex items-center gap-2 text-amber-300 font-medium">
        <MessageSquareWarning className="h-4 w-4 shrink-0" aria-hidden />
        <span>{title}</span>
      </div>
      {count > 0 ? (
        <ul className="mt-2 space-y-2">
          {disputes.map((d, i) => (
            <li key={i} className="min-w-0">
              <code className="block break-all text-xs text-amber-200/90">
                {formatReviewDisputeLocation(d)}
              </code>
              <p className="mt-0.5 whitespace-pre-wrap break-words text-gray-300">{d.reason}</p>
            </li>
          ))}
        </ul>
      ) : !partial && raw ? (
        <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words text-xs text-gray-400">
          {raw}
        </pre>
      ) : null}
    </div>
  );
}
