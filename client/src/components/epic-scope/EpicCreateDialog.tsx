import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { MessagesSquare } from 'lucide-react';
import EpicDetailsPanel from '../EpicDetailsPanel';
import EpicLeadUserField from '../EpicLeadUserField';
import type { AssignableUser } from '../../utils/kanbanUserFilter';

type EpicCreateDialogProps = {
  open: boolean;
  onClose: () => void;
  form: Record<string, any>;
  onChange: (patch: Record<string, any>) => void;
  users?: AssignableUser[];
  busy: boolean;
  error: string | null;
  intent?: 'create' | 'scope';
  onCreate: () => void;
  onCreateAndScope: () => void;
};

export default function EpicCreateDialog({
  open,
  onClose,
  form,
  onChange,
  users = [],
  busy,
  error,
  intent = 'create',
  onCreate,
  onCreateAndScope,
}: EpicCreateDialogProps) {
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busy) onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, onClose, busy]);

  if (!open) return null;

  const canSubmit = Boolean(form.name?.trim()) && !busy;

  return createPortal(
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 p-4"
      onClick={() => {
        if (!busy) onClose();
      }}
      data-testid="epic-create-dialog-backdrop"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="epic-create-dialog-title"
        className="flex max-h-[90vh] w-full max-w-2xl flex-col overflow-hidden rounded-xl border border-zinc-700 bg-zinc-900 shadow-2xl"
        onClick={(event) => event.stopPropagation()}
        data-testid="epic-create-dialog"
      >
        <div className="flex shrink-0 items-center justify-between border-b border-zinc-800 px-5 py-4">
          <h2 id="epic-create-dialog-title" className="text-base font-semibold text-zinc-100">
            New epic
          </h2>
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="rounded-lg p-1.5 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200 disabled:opacity-50"
            aria-label="Close"
          >
            ✕
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          {error ? (
            <p className="mb-4 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-300">
              {error}
            </p>
          ) : null}
          <EpicDetailsPanel form={form} onChange={onChange} autoFocusName />
          {users.length > 0 ? (
            <div className="mt-5">
              <EpicLeadUserField
                users={users}
                value={form.assigned_user_id || ''}
                onChange={(assigned_user_id) => onChange({ assigned_user_id })}
                disabled={busy}
              />
            </div>
          ) : null}
        </div>

        <div className="flex shrink-0 flex-wrap items-center justify-end gap-2 border-t border-zinc-800 px-5 py-4">
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="px-3 py-1.5 text-xs font-medium text-zinc-400 hover:text-zinc-200 disabled:opacity-50"
          >
            Cancel
          </button>
          {intent === 'create' ? (
            <button
              type="button"
              onClick={onCreate}
              disabled={!canSubmit}
              data-testid="epic-create-button"
              className="px-3 py-1.5 text-xs font-medium bg-white/[0.06] hover:bg-white/[0.1] disabled:opacity-40 text-gray-200 rounded-lg transition-colors"
            >
              {busy ? 'Creating…' : 'Create epic'}
            </button>
          ) : null}
          <button
            type="button"
            onClick={onCreateAndScope}
            disabled={!canSubmit}
            data-testid="epic-create-scope-button"
            title="Create the epic and open a scoping session that already knows it"
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-indigo-600 hover:bg-indigo-500 disabled:bg-indigo-600/40 text-white rounded-lg transition-colors"
          >
            <MessagesSquare size={13} />
            {busy ? 'Creating…' : 'Create & scope'}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
