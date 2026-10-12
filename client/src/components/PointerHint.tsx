import { ArrowDown, X } from 'lucide-react';

/** Dismissible callout with a bouncing arrow aimed at the nav item below it. */
export default function PointerHint({
  message,
  dismissLabel,
  onDismiss,
  testId,
}: {
  message: string;
  dismissLabel: string;
  onDismiss: () => void;
  testId?: string;
}) {
  return (
    <div
      role="status"
      data-testid={testId}
      className="rounded-lg border border-emerald-500/40 bg-emerald-500/10 p-3 text-xs text-emerald-200"
    >
      <div className="flex items-start gap-2">
        <p className="flex-1">{message}</p>
        <button
          type="button"
          aria-label={dismissLabel}
          onClick={onDismiss}
          className="p-1 rounded hover:bg-emerald-500/20"
        >
          <X size={14} />
        </button>
      </div>
      <ArrowDown aria-hidden="true" size={22} className="mt-2 ml-3 motion-safe:animate-bounce" />
    </div>
  );
}
