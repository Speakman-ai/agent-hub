import { X, Zap } from 'lucide-react';
import EpicAutonomousPanel from './EpicAutonomousPanel.jsx';

/** Modal for editing autonomous dispatch settings from the kanban board. */
export default function EpicAutonomousDialog({
  open,
  epic,
  form,
  onChange,
  modelConfig,
  saving = false,
  onSave,
  onClose,
}) {
  if (!open || !epic) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      data-testid="epic-autonomous-dialog"
    >
      <button
        type="button"
        className="absolute inset-0 bg-black/70 backdrop-blur-sm"
        aria-label="Close autonomous settings"
        onClick={onClose}
      />
      <div className="relative w-full max-w-lg max-h-[90vh] overflow-y-auto rounded-2xl border border-white/[0.1] bg-gray-950 shadow-2xl shadow-black/60">
        <div className="sticky top-0 z-10 flex items-center gap-3 border-b border-white/[0.08] bg-gray-950/95 px-5 py-4 backdrop-blur-sm">
          <span
            className="w-2.5 h-2.5 rounded-full flex-shrink-0 ring-2 ring-white/10"
            style={{ backgroundColor: epic.color }}
          />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <Zap size={16} className="text-emerald-400 flex-shrink-0" />
              <h2 className="text-base font-semibold text-gray-100 truncate">
                Autonomous dispatch
              </h2>
            </div>
            <p className="text-xs text-gray-500 truncate mt-0.5">{epic.name}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 rounded-lg text-gray-400 hover:text-gray-200 hover:bg-white/[0.06] transition-colors"
            aria-label="Close"
          >
            <X size={18} />
          </button>
        </div>

        <div className="px-5 py-5">
          <EpicAutonomousPanel form={form} onChange={onChange} modelConfig={modelConfig} />
        </div>

        <div className="sticky bottom-0 flex items-center justify-end gap-2 border-t border-white/[0.08] bg-gray-950/95 px-5 py-4 backdrop-blur-sm">
          <button
            type="button"
            onClick={onClose}
            disabled={saving}
            className="px-4 py-2 text-sm text-gray-400 hover:text-gray-200 transition-colors disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onSave}
            disabled={saving}
            data-testid="autonomous-dialog-save"
            className="px-4 py-2 text-sm font-medium rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white transition-colors disabled:opacity-50"
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}
