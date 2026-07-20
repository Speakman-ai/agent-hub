/**
 * Pure logic for kanban card templates, shared by the web
 * (`client/src/utils/kanbanCardTemplates.ts` re-exports these) and mobile
 * (`mobile/src/screens/KanbanCardTemplatesScreen.tsx`) clients so the two
 * surfaces can't drift. Reusable defaults for new kanban cards on a project
 * board; the server already returns rows in this client shape
 * (`server/kanban-card-templates.ts` `templateRowToClient`).
 *
 * Browser-only concerns (the legacy localStorage migration source) stay in the
 * web util — nothing here touches `localStorage`, `window`, or the DOM.
 */

export type KanbanCardTemplatePriority = 'low' | 'medium' | 'high' | 'urgent';

export type KanbanCardTemplate = {
  id: string;
  name: string;
  title: string;
  description: string;
  priority: KanbanCardTemplatePriority;
  labels: string;
  epicId: string;
  updatedAt: string;
};

export type KanbanCardTemplateInput = Omit<KanbanCardTemplate, 'id' | 'updatedAt'>;

const PRIORITIES = new Set<KanbanCardTemplatePriority>(['low', 'medium', 'high', 'urgent']);

export function normalizeCardTemplatePriority(raw: unknown): KanbanCardTemplatePriority {
  if (typeof raw === 'string' && PRIORITIES.has(raw as KanbanCardTemplatePriority)) {
    return raw as KanbanCardTemplatePriority;
  }
  return 'medium';
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

/**
 * Coerce a raw server row (or a partial one) into a fully-populated template
 * with safe defaults. The Hub API already returns this shape, but a defensive
 * normalize keeps the mobile list render and apply-on-create free of undefined
 * field guards.
 */
export function normalizeCardTemplate(row: any): KanbanCardTemplate {
  return {
    id: String(row?.id ?? ''),
    name: typeof row?.name === 'string' ? row.name : '',
    title: typeof row?.title === 'string' ? row.title : '',
    description: typeof row?.description === 'string' ? row.description : '',
    priority: normalizeCardTemplatePriority(row?.priority),
    labels: typeof row?.labels === 'string' ? row.labels : '',
    epicId: typeof row?.epicId === 'string' ? row.epicId : '',
    updatedAt: typeof row?.updatedAt === 'string' ? row.updatedAt : new Date(0).toISOString(),
  };
}

/**
 * Build the request body for POST/PUT `/board/card-templates`. Empty optional
 * strings collapse to `null` (matching the web save handler) and the name is
 * trimmed so a whitespace-only name never persists.
 */
export function cardTemplateApiBody(input: KanbanCardTemplateInput): {
  name: string;
  title: string;
  description: string | null;
  priority: KanbanCardTemplatePriority;
  labels: string | null;
  epicId: string | null;
} {
  return {
    name: input.name.trim(),
    title: input.title,
    description: input.description || null,
    priority: input.priority,
    labels: input.labels || null,
    epicId: input.epicId || null,
  };
}

/** Merge template defaults into a card-detail form object (web card modal). */
export function applyCardTemplateToDetailForm<T extends Record<string, any>>(
  form: T,
  template: KanbanCardTemplate,
): T & {
  title: string;
  description: string;
  priority: KanbanCardTemplatePriority;
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

/**
 * Build a create-card payload from a template for the mobile inline add-card
 * flow (apply-on-create). The caller supplies the target column; an active epic
 * filter on the board wins over the template's own epic so the card lands in the
 * filtered view (matches the web board's create-in-filtered-epic behaviour).
 */
export function templateCreateCardPayload(
  template: KanbanCardTemplate,
  opts: { columnId: string; title?: string; epicId?: string | null } = { columnId: '' },
): {
  title: string;
  columnId: string;
  priority: KanbanCardTemplatePriority;
  description?: string;
  labels?: string;
  epicId?: string;
} {
  const title = (opts.title ?? template.title).trim();
  const payload: {
    title: string;
    columnId: string;
    priority: KanbanCardTemplatePriority;
    description?: string;
    labels?: string;
    epicId?: string;
  } = {
    title,
    columnId: opts.columnId,
    priority: template.priority,
  };
  if (template.description) payload.description = template.description;
  if (template.labels) payload.labels = template.labels;
  const epicId = opts.epicId || template.epicId;
  if (epicId) payload.epicId = epicId;
  return payload;
}
