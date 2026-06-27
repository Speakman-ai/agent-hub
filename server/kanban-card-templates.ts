import type { KanbanCardTemplateRow } from './types.js';

export type KanbanCardTemplateClient = {
  id: string;
  name: string;
  title: string;
  description: string;
  priority: 'low' | 'medium' | 'high' | 'urgent';
  labels: string;
  epicId: string;
  updatedAt: string;
};

const PRIORITIES = new Set(['low', 'medium', 'high', 'urgent']);

export function templateRowToClient(row: KanbanCardTemplateRow): KanbanCardTemplateClient {
  const priority = PRIORITIES.has(row.priority) ? row.priority : 'medium';
  return {
    id: row.id,
    name: row.name,
    title: row.title || '',
    description: row.description || '',
    priority: priority as KanbanCardTemplateClient['priority'],
    labels: row.labels || '',
    epicId: row.epic_id || '',
    updatedAt: row.updated_at,
  };
}

export function normalizeTemplatePriority(raw: unknown): 'low' | 'medium' | 'high' | 'urgent' {
  if (typeof raw === 'string' && PRIORITIES.has(raw))
    return raw as 'low' | 'medium' | 'high' | 'urgent';
  return 'medium';
}
