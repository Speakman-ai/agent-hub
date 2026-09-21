import { ArrowDown, X } from 'lucide-react';

export default function AiSignInHint({
  target,
  onDismiss,
}: {
  target: 'Settings' | 'Account';
  onDismiss: () => void;
}) {
  return (
    <div
      role="status"
      className="rounded-lg border border-emerald-500/40 bg-emerald-500/10 p-3 text-xs text-emerald-200"
    >
      <div className="flex items-start gap-2">
        <p className="flex-1">
          {target === 'Settings'
            ? 'Open Settings to connect your AI account.'
            : 'Choose Account to sign in with your AI credentials.'}
        </p>
        <button
          type="button"
          aria-label="Dismiss AI sign-in guide"
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
