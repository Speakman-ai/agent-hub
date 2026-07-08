/**
 * promoteTodo.ts — the pure logic behind the promote-to-ticket picker (spec
 * TODO-TO-TICKET PROMOTE op), shared 1:1 between the web `PromoteTodoModal` and
 * the mobile one so both clients build the same write payload and pick the same
 * defaults. Kept free of React / network so it is unit-testable in isolation.
 *
 * The picker collects a destination (project + column + optional epic) and the
 * card priority, then POSTs `POST /api/me/todos/:id/promote`. The endpoint
 * defaults the column to the board's "To Do" lane and carries the todo's
 * priority — these helpers mirror those defaults on the client so the picker
 * pre-fills sensibly.
 */

/** Card priority — mirrors the kanban-card enum so a promote maps 1:1. */
export type PromotePriority = 'urgent' | 'high' | 'medium' | 'low';

/** A project board column / epic narrowed to what the picker chips need. */
export interface PromoteOption {
  id: string;
  name: string;
}

/** The exact body `POST /api/me/todos/:id/promote` accepts. */
export interface PromotePayload {
  projectId: string;
  columnId: string;
  priority: PromotePriority;
  epicId?: string;
}

export const PROMOTE_PRIORITY_OPTIONS: PromotePriority[] = ['urgent', 'high', 'medium', 'low'];

/**
 * Normalize an unknown board sub-array (`board.columns` or `board.epics`) into
 * `{ id, name }` options, dropping anything that isn't an object. Ids/names are
 * stringified so a numeric id from the API still compares cleanly.
 */
export function normalizePromoteOptions(rows: unknown): PromoteOption[] {
  if (!Array.isArray(rows)) return [];
  return rows
    .filter((r): r is Record<string, unknown> => !!r && typeof r === 'object')
    .map((r) => ({ id: String((r as any).id), name: String((r as any).name) }));
}

/** The default selected option (the board's first / leftmost lane), or '' if none. */
export function defaultPromoteOptionId(options: PromoteOption[]): string {
  return options.length ? options[0].id : '';
}

/** The picker's default priority: the todo's own priority, falling back to medium. */
export function defaultPromotePriority(todo: {
  priority?: PromotePriority | null;
}): PromotePriority {
  return todo?.priority ?? 'medium';
}

/**
 * Build the promote request body from the picker selections. `epicId` is omitted
 * entirely when unset (the endpoint treats a missing epic as "no epic"); a blank
 * string is never sent.
 */
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

/** Whether the picker has enough selected to submit (project + column). */
export function canSubmitPromote(input: {
  projectId: string;
  columnId: string;
  submitting: boolean;
  loadingBoard: boolean;
}): boolean {
  return !!input.projectId && !!input.columnId && !input.submitting && !input.loadingBoard;
}
