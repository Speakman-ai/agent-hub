import { Eraser } from 'lucide-react';

export default function HubClearChatButton({
  onClear,
  clearing = false,
  disabled = false,
}: {
  onClear?: () => void;
  clearing?: boolean;
  disabled?: boolean;
}) {
  if (!onClear) return null;
  return (
    <button
      type="button"
      data-testid="hub-clear-chat"
      onClick={onClear}
      disabled={disabled || clearing}
      className="inline-flex items-center gap-1 rounded-md border border-gray-800 bg-gray-900 px-2 py-1 text-[11px] font-medium text-gray-300 hover:text-white hover:bg-gray-800 transition-colors disabled:opacity-50"
      title="Clear this Hub chat"
    >
      <Eraser size={12} />
      {clearing ? 'Clearing…' : 'Clear'}
    </button>
  );
}
