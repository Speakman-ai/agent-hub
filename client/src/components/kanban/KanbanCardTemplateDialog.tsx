import { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import {
  blankCardTemplateInput,
  type KanbanCardTemplate,
  type KanbanCardTemplateInput,
} from '../../utils/kanbanCardTemplates';

const PRIORITIES = ['urgent', 'high', 'medium', 'low'] as const;

type EpicRow = { id: string; name: string };

type Props = {
  open: boolean;
  template?: KanbanCardTemplate | null;
  epics?: EpicRow[];
  saving?: boolean;
  error?: string | null;
  onClose: () => void;
  onSave: (input: KanbanCardTemplateInput) => void;
};

export default function KanbanCardTemplateDialog({
  open,
  template = null,
  epics = [],
  saving = false,
  error = null,
  onClose,
  onSave,
}: Props) {
  const [form, setForm] = useState<KanbanCardTemplateInput>(() => blankCardTemplateInput());

  useEffect(() => {
    if (!open) return;
    if (template) {
      setForm({
        name: template.name,
        title: template.title,
        description: template.description,
        priority: template.priority,
        labels: template.labels,
        epicId: template.epicId,
      });
    } else {
      setForm(blankCardTemplateInput());
    }
  }, [open, template]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center p-4"
      data-testid="kanban-card-template-dialog"
    >
      <div
        className="absolute inset-0 bg-black/70 backdrop-blur-sm"
        onClick={() => !saving && onClose()}
      />
      <div className="relative w-full max-w-lg rounded-2xl border border-white/10 bg-gray-950 shadow-2xl">
        <div className="flex items-center justify-between px-5 py-4 border-b border-white/[0.06]">
          <h2 className="text-sm font-semibold text-gray-100">
            {template ? 'Edit template' : 'New template'}
          </h2>
          <button
            type="button"
            onClick={onClose}
            disabled={saving}
            aria-label="Close"
            className="p-1.5 text-gray-500 hover:text-gray-200 rounded-lg"
          >
            <X size={16} />
          </button>
        </div>

        <div className="px-5 py-4 space-y-4 max-h-[70vh] overflow-y-auto">
          <label className="block">
            <span className="text-xs font-medium text-gray-500 uppercase tracking-wider">Name</span>
            <input
              type="text"
              value={form.name}
              onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
              placeholder="Bug report"
              data-testid="template-name"
              className="mt-1.5 w-full bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-gray-500"
            />
          </label>

          <label className="block">
            <span className="text-xs font-medium text-gray-500 uppercase tracking-wider">
              Default title
            </span>
            <input
              type="text"
              value={form.title}
              onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))}
              placeholder="Card title when applied"
              data-testid="template-title"
              className="mt-1.5 w-full bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-gray-500"
            />
          </label>

          <label className="block">
            <span className="text-xs font-medium text-gray-500 uppercase tracking-wider">
              Description
            </span>
            <textarea
              value={form.description}
              onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
              rows={6}
              placeholder="Problem, acceptance criteria, context…"
              data-testid="template-description"
              className="mt-1.5 w-full bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-gray-500 resize-y min-h-[120px]"
            />
          </label>

          <label className="block">
            <span className="text-xs font-medium text-gray-500 uppercase tracking-wider">
              Priority
            </span>
            <select
              value={form.priority}
              onChange={(e) =>
                setForm((f) => ({
                  ...f,
                  priority: e.target.value as KanbanCardTemplateInput['priority'],
                }))
              }
              data-testid="template-priority"
              className="mt-1.5 w-full bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-gray-500"
            >
              {PRIORITIES.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
          </label>

          <label className="block">
            <span className="text-xs font-medium text-gray-500 uppercase tracking-wider">
              Labels
            </span>
            <input
              type="text"
              value={form.labels}
              onChange={(e) => setForm((f) => ({ ...f, labels: e.target.value }))}
              placeholder="bug, feature"
              data-testid="template-labels"
              className="mt-1.5 w-full bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-gray-500"
            />
          </label>

          <label className="block">
            <span className="text-xs font-medium text-gray-500 uppercase tracking-wider">Epic</span>
            <select
              value={form.epicId}
              onChange={(e) => setForm((f) => ({ ...f, epicId: e.target.value }))}
              data-testid="template-epic"
              className="mt-1.5 w-full bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-gray-500"
            >
              <option value="">None</option>
              {epics.map((epic) => (
                <option key={epic.id} value={epic.id}>
                  {epic.name}
                </option>
              ))}
            </select>
          </label>

          {error ? <p className="text-xs text-red-400">{error}</p> : null}
        </div>

        <div className="flex items-center justify-end gap-2 px-5 py-4 border-t border-white/[0.06]">
          <button
            type="button"
            onClick={onClose}
            disabled={saving}
            className="px-3 py-1.5 text-sm text-gray-400 hover:text-gray-200"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={saving || !form.name.trim()}
            data-testid="template-save"
            onClick={() => onSave(form)}
            className="px-4 py-1.5 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white rounded-lg text-sm font-medium"
          >
            {saving ? 'Saving…' : template ? 'Save changes' : 'Create template'}
          </button>
        </div>
      </div>
    </div>
  );
}
