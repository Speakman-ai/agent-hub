import { useEffect, useState } from 'react';
import { X, Trash2, ChevronLeft, ChevronRight, AlertTriangle, Lock } from 'lucide-react';

export const COLUMN_COLOR_PRESETS = [
  '#3B82F6',
  '#F59E0B',
  '#10B981',
  '#8B5CF6',
  '#EC4899',
  '#6B7280',
];

type ColumnLike = {
  id: string;
  name: string;
  position: number;
  color?: string | null;
};

type KanbanColumnDialogProps = {
  open: boolean;
  mode: 'create' | 'edit';
  column?: ColumnLike | null;
  columns?: ColumnLike[];
  cardCount?: number;
  locked?: boolean;
  saving?: boolean;
  error?: string | null;
  onClose: () => void;
  onSave: (data: { name: string; color: string }) => void;
  onDelete?: () => void;
  onMove?: (direction: 'left' | 'right') => void;
};

export default function KanbanColumnDialog({
  open,
  mode,
  column,
  columns = [],
  cardCount = 0,
  locked = false,
  saving = false,
  error = null,
  onClose,
  onSave,
  onDelete,
  onMove,
}: KanbanColumnDialogProps) {
  const [name, setName] = useState('');
  const [color, setColor] = useState(COLUMN_COLOR_PRESETS[0]);
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => {
    if (!open) {
      setConfirmDelete(false);
      return;
    }
    if (mode === 'edit' && column) {
      setName(column.name);
      setColor(column.color || COLUMN_COLOR_PRESETS[0]);
    } else {
      setName('');
      setColor(COLUMN_COLOR_PRESETS[columns.length % COLUMN_COLOR_PRESETS.length]);
    }
    setConfirmDelete(false);
  }, [open, mode, column, columns.length]);

  if (!open) return null;

  const sorted = [...columns].sort((a, b) => a.position - b.position);
  const columnIndex = column ? sorted.findIndex((c) => c.id === column.id) : -1;
  const canMoveLeft = mode === 'edit' && columnIndex > 0;
  const canMoveRight = mode === 'edit' && columnIndex >= 0 && columnIndex < sorted.length - 1;
  const isLastColumn = sorted.length <= 1;
  const deleteBlocked = locked || cardCount > 0 || isLastColumn;
  const deleteReason = locked
    ? 'To Do, In Progress, and Done are required by board automation and cannot be deleted.'
    : cardCount > 0
      ? `This column still has ${cardCount} card${cardCount === 1 ? '' : 's'}. Move or delete them first.`
      : isLastColumn
        ? 'A board must have at least one column.'
        : null;

  const handleSubmit = (e: any) => {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;
    onSave({
      name: trimmed,
      color,
    });
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      data-testid="kanban-column-dialog"
    >
      <button
        type="button"
        className="absolute inset-0 bg-black/70 backdrop-blur-sm"
        aria-label="Close column dialog"
        onClick={onClose}
      />
      <div className="relative w-full max-w-md rounded-2xl border border-white/[0.1] bg-gray-950 shadow-2xl shadow-black/60">
        <div className="flex items-center gap-3 border-b border-white/[0.08] px-5 py-4">
          <span
            className="w-2.5 h-2.5 rounded-full flex-shrink-0 ring-2 ring-white/10"
            style={{ backgroundColor: color }}
          />
          <div className="min-w-0 flex-1">
            <h2 className="text-base font-semibold text-gray-100">
              {mode === 'create' ? 'Add column' : 'Edit column'}
            </h2>
            {mode === 'edit' && column ? (
              <p className="text-xs text-gray-500 truncate mt-0.5">{column.name}</p>
            ) : null}
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

        <form onSubmit={handleSubmit} className="px-5 py-5 space-y-5">
          {locked ? (
            <div
              className="flex items-start gap-2 rounded-xl border border-amber-500/20 bg-amber-500/10 px-3 py-2.5 text-xs text-amber-100"
              data-testid="kanban-column-locked-notice"
            >
              <Lock size={14} className="mt-0.5 flex-shrink-0 text-amber-300" />
              <span>
                This column is required by board automation. You can change its color or position,
                but not its name or delete it.
              </span>
            </div>
          ) : null}

          <div>
            <label
              htmlFor="kanban-column-name"
              className="block text-xs font-medium text-gray-400 mb-1.5"
            >
              Name
            </label>
            <input
              id="kanban-column-name"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Column name"
              autoFocus={!locked}
              disabled={locked}
              data-testid="kanban-column-name-input"
              className="w-full bg-white/[0.04] border border-white/[0.08] text-sm text-gray-100 rounded-lg px-3 h-10 focus:outline-none focus:ring-1 focus:ring-indigo-500/50 focus:border-indigo-500/50 placeholder-gray-500 disabled:opacity-60 disabled:cursor-not-allowed"
            />
          </div>

          <div>
            <label className="block text-xs font-medium text-gray-400 mb-1.5">Color</label>
            <div className="flex items-center gap-3 flex-wrap">
              {COLUMN_COLOR_PRESETS.map((preset) => (
                <button
                  key={preset}
                  type="button"
                  aria-label={`Use color ${preset}`}
                  data-testid={`kanban-column-color-${preset}`}
                  onClick={() => setColor(preset)}
                  className={`w-7 h-7 rounded-full border-2 transition-transform ${
                    color === preset
                      ? 'border-white scale-110'
                      : 'border-transparent hover:scale-105'
                  }`}
                  style={{ backgroundColor: preset }}
                />
              ))}
              <input
                type="color"
                value={color}
                onChange={(e) => setColor(e.target.value)}
                data-testid="kanban-column-color-picker"
                className="w-9 h-9 rounded border border-white/[0.08] cursor-pointer bg-transparent"
                aria-label="Custom column color"
              />
            </div>
          </div>

          {mode === 'edit' && onMove ? (
            <div>
              <label className="block text-xs font-medium text-gray-400 mb-1.5">Position</label>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  disabled={!canMoveLeft || saving}
                  onClick={() => onMove('left')}
                  data-testid="kanban-column-move-left"
                  className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg text-xs font-medium border border-white/[0.08] bg-white/[0.04] text-gray-300 hover:bg-white/[0.08] disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  <ChevronLeft size={14} />
                  Move left
                </button>
                <button
                  type="button"
                  disabled={!canMoveRight || saving}
                  onClick={() => onMove('right')}
                  data-testid="kanban-column-move-right"
                  className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg text-xs font-medium border border-white/[0.08] bg-white/[0.04] text-gray-300 hover:bg-white/[0.08] disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  Move right
                  <ChevronRight size={14} />
                </button>
              </div>
            </div>
          ) : null}

          {error ? (
            <p className="text-sm text-red-400" data-testid="kanban-column-error">
              {error}
            </p>
          ) : null}

          {mode === 'edit' && onDelete && !locked ? (
            <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-3">
              {!confirmDelete ? (
                <button
                  type="button"
                  disabled={deleteBlocked || saving}
                  onClick={() => setConfirmDelete(true)}
                  data-testid="kanban-column-delete"
                  className="inline-flex items-center gap-1.5 text-sm text-red-400 hover:text-red-300 disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  <Trash2 size={14} />
                  Delete column
                </button>
              ) : (
                <div className="space-y-3">
                  <div className="flex items-start gap-2 text-sm text-red-300">
                    <AlertTriangle size={16} className="mt-0.5 flex-shrink-0" />
                    <span>Delete this column permanently?</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      disabled={saving}
                      onClick={onDelete}
                      data-testid="kanban-column-delete-confirm"
                      className="px-3 py-1.5 rounded-lg text-xs font-medium bg-red-600 hover:bg-red-500 text-white disabled:opacity-50"
                    >
                      {saving ? 'Deleting…' : 'Delete'}
                    </button>
                    <button
                      type="button"
                      disabled={saving}
                      onClick={() => setConfirmDelete(false)}
                      className="px-3 py-1.5 rounded-lg text-xs text-gray-400 hover:text-gray-200"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              )}
              {deleteReason ? (
                <p
                  className="text-xs text-gray-500 mt-2"
                  data-testid="kanban-column-delete-blocked"
                >
                  {deleteReason}
                </p>
              ) : null}
            </div>
          ) : null}

          <div className="flex items-center justify-end gap-2 pt-1">
            <button
              type="button"
              onClick={onClose}
              disabled={saving}
              className="px-4 py-2 text-sm text-gray-400 hover:text-gray-200 transition-colors disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={saving || !name.trim()}
              data-testid="kanban-column-save"
              className="px-4 py-2 text-sm font-medium rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white transition-colors disabled:opacity-50"
            >
              {saving ? 'Saving…' : mode === 'create' ? 'Add column' : 'Save'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
