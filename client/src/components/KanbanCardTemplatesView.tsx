import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowLeft, FileText, Pencil, Plus, Trash2 } from 'lucide-react';
import { api } from '../utils/api';
import {
  clearLegacyLocalCardTemplates,
  readLegacyLocalCardTemplates,
  type KanbanCardTemplate,
  type KanbanCardTemplateInput,
} from '../utils/kanbanCardTemplates';
import KanbanCardTemplateDialog from './kanban/KanbanCardTemplateDialog';

type EpicRow = { id: string; name: string };

type Props = {
  projectId: string;
  project?: { id: string; name?: string; color?: string | null } | null;
  refreshKey?: number;
  onBackToBoard: () => void;
  onUseTemplate?: (template: KanbanCardTemplate) => void;
};

function templateMigrationKey(template: Pick<KanbanCardTemplate, keyof KanbanCardTemplateInput>) {
  return JSON.stringify({
    name: template.name,
    title: template.title || '',
    description: template.description || '',
    priority: template.priority || 'medium',
    labels: template.labels || '',
    epicId: template.epicId || '',
  });
}

export default function KanbanCardTemplatesView({
  projectId,
  project,
  refreshKey = 0,
  onBackToBoard,
  onUseTemplate,
}: Props) {
  const [templates, setTemplates] = useState<KanbanCardTemplate[]>([]);
  const [epics, setEpics] = useState<EpicRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [dialog, setDialog] = useState<{
    mode: 'create' | 'edit';
    template?: KanbanCardTemplate;
  } | null>(null);
  const [dialogError, setDialogError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [confirmDeleteTemplateId, setConfirmDeleteTemplateId] = useState<string | null>(null);
  const migratedProjectIdsRef = useRef<Set<string>>(new Set());
  const activeProjectIdRef = useRef(projectId);

  activeProjectIdRef.current = projectId;

  const fetchTemplates = useCallback(
    async (targetProjectId = projectId) => {
      if (!targetProjectId) return;
      try {
        const rows = await api.getCardTemplates(targetProjectId);
        if (activeProjectIdRef.current !== targetProjectId) return;
        setTemplates(Array.isArray(rows) ? rows : []);
        setError(null);
      } catch (err: any) {
        if (activeProjectIdRef.current !== targetProjectId) return;
        setError(err?.message || 'Failed to load templates');
      } finally {
        if (activeProjectIdRef.current === targetProjectId) setLoading(false);
      }
    },
    [projectId],
  );

  const migrateLegacyTemplates = useCallback(async () => {
    if (!projectId || migratedProjectIdsRef.current.has(projectId)) return;
    migratedProjectIdsRef.current.add(projectId);
    const legacy = readLegacyLocalCardTemplates(projectId);
    if (legacy.length === 0) return;
    try {
      const existing = await api.getCardTemplates(projectId);
      const existingKeys = new Set(
        (Array.isArray(existing) ? existing : []).map((row) => templateMigrationKey(row)),
      );
      for (const row of legacy) {
        const key = templateMigrationKey(row);
        if (existingKeys.has(key)) continue;
        await api.createCardTemplate(projectId, {
          name: row.name,
          title: row.title,
          description: row.description || null,
          priority: row.priority,
          labels: row.labels || null,
          epicId: row.epicId || null,
        });
        existingKeys.add(key);
      }
      clearLegacyLocalCardTemplates(projectId);
    } catch {
      migratedProjectIdsRef.current.delete(projectId);
    }
  }, [projectId]);

  useEffect(() => {
    const requestedProjectId = projectId;
    setLoading(true);
    void migrateLegacyTemplates().finally(() => {
      void fetchTemplates(requestedProjectId);
    });
  }, [fetchTemplates, migrateLegacyTemplates, projectId, refreshKey]);

  useEffect(() => {
    if (!projectId) return;
    let cancelled = false;
    api
      .getEpics(projectId)
      .then((rows) => {
        if (!cancelled) setEpics(Array.isArray(rows) ? rows : []);
      })
      .catch(() => {
        if (!cancelled) setEpics([]);
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, refreshKey]);

  const handleSave = async (input: KanbanCardTemplateInput) => {
    setDialogError(null);
    setSaving(true);
    try {
      if (dialog?.mode === 'edit' && dialog.template) {
        await api.updateCardTemplate(projectId, dialog.template.id, {
          name: input.name.trim(),
          title: input.title,
          description: input.description || null,
          priority: input.priority,
          labels: input.labels || null,
          epicId: input.epicId || null,
        });
      } else {
        await api.createCardTemplate(projectId, {
          name: input.name.trim(),
          title: input.title,
          description: input.description || null,
          priority: input.priority,
          labels: input.labels || null,
          epicId: input.epicId || null,
        });
      }
      setDialog(null);
      await fetchTemplates();
    } catch (err: any) {
      setDialogError(err?.message || 'Failed to save template');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (id: string) => {
    try {
      await api.deleteCardTemplate(projectId, id);
      await fetchTemplates();
    } catch (err: any) {
      setError(err?.message || 'Failed to delete template');
    } finally {
      setConfirmDeleteTemplateId(null);
    }
  };

  if (loading) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-3 bg-gray-950 text-gray-500">
        <div className="h-8 w-8 rounded-full border-2 border-gray-700 border-t-indigo-500 animate-spin" />
        <p className="text-sm">Loading templates…</p>
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col bg-gray-950 min-h-0">
      <div className="flex items-center justify-between gap-3 px-5 py-3.5 border-b border-white/[0.06] bg-gray-950/90 backdrop-blur-sm">
        <div className="flex items-center gap-2 min-w-0">
          <button
            type="button"
            onClick={onBackToBoard}
            data-testid="templates-back-to-board"
            className="flex items-center gap-1.5 h-9 px-2.5 rounded-lg text-xs font-medium text-gray-400 hover:text-gray-200 hover:bg-white/[0.06] transition-colors"
          >
            <ArrowLeft size={14} />
            Board
          </button>
          {project?.color ? (
            <span
              className="w-2 h-2 rounded-full ring-2 ring-white/10"
              style={{ backgroundColor: project.color }}
            />
          ) : null}
          <div className="min-w-0">
            <h1 className="text-base font-semibold text-gray-100 truncate">Card templates</h1>
            <p className="text-xs text-gray-500 truncate">
              {templates.length} template{templates.length !== 1 ? 's' : ''} ·{' '}
              {project?.name || 'Project'}
            </p>
          </div>
        </div>
        <button
          type="button"
          onClick={() => {
            setDialogError(null);
            setDialog({ mode: 'create' });
          }}
          data-testid="templates-new"
          className="flex items-center gap-1.5 h-9 px-3 rounded-lg text-xs font-medium text-white bg-indigo-600 hover:bg-indigo-500 transition-colors"
        >
          <Plus size={14} />
          New template
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-5 py-5">
        {error ? (
          <div className="mb-4 rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-300">
            {error}
          </div>
        ) : null}

        <p className="text-sm text-gray-500 mb-4 max-w-2xl">
          Templates pre-fill title, description, priority, labels, and epic when creating a card on
          the board. Agents can list and apply them via{' '}
          <code className="text-gray-400">scripts/kanban-card-templates.sh</code> and{' '}
          <code className="text-gray-400">--template-id</code> on{' '}
          <code className="text-gray-400">kanban-create-card.sh</code>.
        </p>

        {templates.length === 0 ? (
          <div
            className="rounded-xl border border-white/[0.08] bg-white/[0.02] px-6 py-10 text-center"
            data-testid="templates-empty"
          >
            <FileText size={28} className="mx-auto mb-3 text-gray-600" />
            <p className="text-sm text-gray-400 mb-4">No templates yet.</p>
            <button
              type="button"
              onClick={() => {
                setDialogError(null);
                setDialog({ mode: 'create' });
              }}
              className="px-4 py-2 text-sm font-medium text-white bg-indigo-600 hover:bg-indigo-500 rounded-lg"
            >
              Create your first template
            </button>
          </div>
        ) : (
          <ul className="space-y-2 max-w-3xl" data-testid="templates-list">
            {templates.map((template) => (
              <li
                key={template.id}
                className="flex items-start gap-3 rounded-xl border border-white/[0.08] bg-white/[0.02] px-4 py-3"
                data-testid={`template-row-${template.id}`}
              >
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium text-gray-100">{template.name}</div>
                  {template.title ? (
                    <div className="text-xs text-gray-500 mt-0.5 truncate">
                      Title: {template.title}
                    </div>
                  ) : null}
                  <div className="flex flex-wrap gap-2 mt-2 text-[11px] text-gray-500">
                    <span className="rounded bg-white/[0.04] px-2 py-0.5">{template.priority}</span>
                    {template.labels ? (
                      <span className="rounded bg-white/[0.04] px-2 py-0.5">{template.labels}</span>
                    ) : null}
                    {template.epicId ? (
                      <span className="rounded bg-white/[0.04] px-2 py-0.5">
                        Epic: {epics.find((e) => e.id === template.epicId)?.name || template.epicId}
                      </span>
                    ) : null}
                  </div>
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  {onUseTemplate ? (
                    <button
                      type="button"
                      onClick={() => onUseTemplate(template)}
                      data-testid={`template-use-${template.id}`}
                      className="h-8 px-3 rounded-lg text-xs font-medium text-gray-200 bg-white/[0.06] hover:bg-white/[0.1] transition-colors"
                    >
                      Use
                    </button>
                  ) : null}
                  <button
                    type="button"
                    onClick={() => {
                      setDialogError(null);
                      setConfirmDeleteTemplateId(null);
                      setDialog({ mode: 'edit', template });
                    }}
                    data-testid={`template-edit-${template.id}`}
                    aria-label={`Edit template ${template.name}`}
                    className="p-2 text-gray-500 hover:text-indigo-300 transition-colors"
                  >
                    <Pencil size={14} />
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      if (confirmDeleteTemplateId === template.id) {
                        void handleDelete(template.id);
                      } else {
                        setConfirmDeleteTemplateId(template.id);
                      }
                    }}
                    data-testid={`template-delete-${template.id}`}
                    aria-label={
                      confirmDeleteTemplateId === template.id
                        ? `Confirm delete template ${template.name}`
                        : `Delete template ${template.name}`
                    }
                    className={`h-8 rounded-lg transition-colors ${
                      confirmDeleteTemplateId === template.id
                        ? 'px-2 text-xs font-medium text-red-200 bg-red-900/40 hover:bg-red-900/60'
                        : 'p-2 text-gray-500 hover:text-red-300'
                    }`}
                  >
                    {confirmDeleteTemplateId === template.id ? 'Confirm' : <Trash2 size={14} />}
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      <KanbanCardTemplateDialog
        open={dialog != null}
        template={dialog?.mode === 'edit' ? dialog.template : null}
        epics={epics}
        saving={saving}
        error={dialogError}
        onClose={() => {
          if (saving) return;
          setDialog(null);
          setDialogError(null);
        }}
        onSave={handleSave}
      />
    </div>
  );
}
