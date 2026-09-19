/**
 * Promote-to-ticket picker: destination + priority for `POST /api/me/todos/:id/promote`.
 * Defaults match the endpoint (To Do lane, todo's own priority).
 */

/** Card priority; maps 1:1 onto a kanban card. */
export type PromotePriority = 'urgent' | 'high' | 'medium' | 'low';

/** `{ id, name }` for picker chips. */
export interface PromoteOption {
  id: string;
  name: string;
}

/** Body for `POST /api/me/todos/:id/promote`. */
export interface PromotePayload {
  projectId: string;
  columnId: string;
  priority: PromotePriority;
  epicId?: string;
}

export const PROMOTE_PRIORITY_OPTIONS: PromotePriority[] = ['urgent', 'high', 'medium', 'low'];

/** Normalize `board.columns` / `board.epics` to `{ id, name }`. Ids stringified. */
export function normalizePromoteOptions(rows: unknown): PromoteOption[] {
  if (!Array.isArray(rows)) return [];
  return rows
    .filter((r): r is Record<string, unknown> => !!r && typeof r === 'object')
    .map((r) => ({ id: String((r as any).id), name: String((r as any).name) }));
}

/** Leftmost lane, or ''. */
export function defaultPromoteOptionId(options: PromoteOption[]): string {
  return options.length ? options[0].id : '';
}

/** Todo's own priority, else medium. */
export function defaultPromotePriority(todo: {
  priority?: PromotePriority | null;
}): PromotePriority {
  return todo?.priority ?? 'medium';
}

/** Omit `epicId` when unset; never send a blank string. */
export function buildPromotePayload(input: {
  projectId: string;
  columnId: string;
  priority: PromotePriority;
  epicId?: string | null;
}): PromotePayload {
  return {
    projectId: input.projectId,
    columnId: input.columnId,
    priority: input.priority,
    ...(input.epicId ? { epicId: input.epicId } : {}),
  };
}

/** Project + column selected, and not currently submitting/loading. */
export function canSubmitPromote(input: {
  projectId: string;
  columnId: string;
  submitting: boolean;
  loadingBoard: boolean;
}): boolean {
  return !!input.projectId && !!input.columnId && !input.submitting && !input.loadingBoard;
}
