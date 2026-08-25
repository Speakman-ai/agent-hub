/**
 * Browser-only migration source for kanban card templates: the client-only
 * localStorage store that predates the server-backed table. The pure template
 * logic (types, defaults, form-merge, API body) lives in
 * `@shared/utils/kanbanCardTemplates` and is imported directly by both web and
 * mobile — nothing is re-exported here, so the two never drift.
 */
import {
  normalizeCardTemplatePriority,
  type KanbanCardTemplate,
} from '@shared/utils/kanbanCardTemplates';

export function kanbanCardTemplatesKey(projectId: string): string {
  return `kanbanCardTemplates:${projectId}`;
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
        priority: normalizeCardTemplatePriority(row.priority),
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
