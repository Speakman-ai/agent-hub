/**
 * source-provenance.ts — the shared capture-provenance shape (spec
 * CAPTURE-PROVENANCE).
 *
 * Personal todos (`user_todos`) and kanban cards (`kanban_cards`) both carry the
 * same provenance triple `{ source_type, source_id, source_meta }` so a
 * dashboard capture can be traced back to the Gmail message / Calendar event it
 * came from, and a promoted card can point back at the todo it came from. This
 * module is the single source of truth for the enum values and the meta
 * (de)serialization so the two surfaces never drift.
 *
 *   - `source_type`:
 *       - `manual`   hand-created, no external origin
 *       - `email`    captured from a Gmail message
 *       - `calendar` captured from a Calendar event
 *       - `todo`     (cards only) promoted from a personal todo
 *     A todo can never originate from another todo, so the todo surface uses the
 *     narrower `TODO_SOURCE_TYPES`; cards additionally allow `todo`.
 *   - `source_id`: opaque id of the origin (Gmail message id, Calendar event id,
 *     todo id). Nullable.
 *   - `source_meta`: JSON object preserving a deep link back to the origin so a
 *     dashboard can reopen it. Stored as a TEXT JSON blob on the row; exposed as
 *     a parsed object on the API.
 */

/** Provenance sources a kanban card may carry. Superset of the todo sources. */
export const CARD_SOURCE_TYPES = ['manual', 'email', 'calendar', 'todo'] as const;
export type CardSourceType = (typeof CARD_SOURCE_TYPES)[number];

/** Provenance sources a personal todo may carry (never `todo`). */
export const TODO_SOURCE_TYPES = ['manual', 'email', 'calendar'] as const;
export type TodoSourceType = (typeof TODO_SOURCE_TYPES)[number];

/** The capture-provenance triple in its parsed (API) form. */
export interface SourceRef<T extends string = CardSourceType> {
  sourceType: T;
  sourceId: string | null;
  sourceMeta: Record<string, unknown> | null;
}

/**
 * Parse a stored `source_meta` JSON blob into a plain object. Returns null for
 * null/absent input, malformed JSON, or any non-object JSON (arrays, scalars) —
 * the deep-link meta is always a keyed object.
 */
export function parseSourceMeta(json: string | null | undefined): Record<string, unknown> | null {
  if (json == null) return null;
  try {
    const parsed = JSON.parse(json);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** Serialize a `source_meta` object to the stored JSON blob, or null. */
export function serializeSourceMeta(
  meta: Record<string, unknown> | null | undefined,
): string | null {
  return meta != null ? JSON.stringify(meta) : null;
}
