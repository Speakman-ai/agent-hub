/** Reusable defaults for new kanban cards on a project board. */
export type KanbanCardTemplate = {
  id: string;
  name: string;
  title: string;
  description: string;
  priority: 'low' | 'medium' | 'high' | 'urgent';
  labels: string;
  epicId: string;
  updatedAt: string;
};

export type KanbanCardTemplateInput = Omit<KanbanCardTemplate, 'id' | 'updatedAt'>;

const PRIORITIES = new Set(['low', 'medium', 'high', 'urgent']);

export function kanbanCardTemplatesKey(projectId: string): string {
  return `kanbanCardTemplates:${projectId}`;
}

export function blankCardTemplateInput(name = ''): KanbanCardTemplateInput {
  return {
    name,
    title: '',
    description: '',
    priority: 'medium',
    labels: '',
    epicId: '',
  };
}

/** One-time migration source: legacy browser localStorage templates. */
export function readLegacyLocalCardTemplates(
  projectId: string | null | undefined,
): KanbanCardTemplate[] {
  if (!projectId) return [];
  try {
    const raw = localStorage.getItem(kanbanCardTemplatesKey(projectId));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((row) => row && typeof row.id === 'string' && typeof row.name === 'string')
      .map((row) => ({
        id: row.id,
        name: row.name,
        title: typeof row.title === 'string' ? row.title : '',
        description: typeof row.description === 'string' ? row.description : '',
        priority: PRIORITIES.has(row.priority) ? row.priority : 'medium',
        labels: typeof row.labels === 'string' ? row.labels : '',
        epicId: typeof row.epicId === 'string' ? row.epicId : '',
        updatedAt: typeof row.updatedAt === 'string' ? row.updatedAt : new Date(0).toISOString(),
      }));
  } catch {
    return [];
  }
}

export function clearLegacyLocalCardTemplates(projectId: string): void {
  try {
    localStorage.removeItem(kanbanCardTemplatesKey(projectId));
  } catch {
    // Best-effort cleanup.
  }
}

/** Merge template defaults into a card detail form object. */
export function applyCardTemplateToDetailForm<T extends Record<string, any>>(
  form: T,
  template: KanbanCardTemplate,
): T & {
  title: string;
  description: string;
  priority: KanbanCardTemplate['priority'];
  labels: string;
  epic_id: string;
} {
  return {
    ...form,
    title: template.title,
    description: template.description,
    priority: template.priority,
    labels: template.labels,
    epic_id: template.epicId || '',
  };
}
