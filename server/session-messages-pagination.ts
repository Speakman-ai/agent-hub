import type { MessageRow } from './types.js';

/**
 * Keyset pagination for GET /api/sessions/:id/messages.
 *
 * Transcripts grow without bound (a single finalize can append hundreds of
 * messages), so the client lazy-loads the newest page first and fetches older
 * pages on scroll-up ("reverse infinite scroll"). We key off the SQLite
 * `rowid` rather than `created_at`: `created_at` is second-resolution and
 * collides constantly within a session, which would make an ORDER BY
 * created_at cursor skip or duplicate rows. `rowid` is monotonic with insert
 * order (== chronological order) and unique, so it is a stable cursor.
 *
 * The cursor exposed to the client is the oldest loaded message's `id` (the
 * server resolves it to a rowid via subquery). The paginated response is a
 * plain oldest-first array — identical in shape to the legacy response — so
 * existing callers and `api.getMessages` keep working unchanged. The client
 * infers "older messages exist" from page fullness (a full page implies more).
 */

export const DEFAULT_MESSAGES_PAGE_SIZE = 40;
export const MAX_MESSAGES_PAGE_SIZE = 200;

/**
 * Whether the request opted into keyset pagination. We gate on an explicit
 * `paginated` flag (or the presence of a `before` cursor) so the legacy
 * load-all `?limit=` slice and the un-paginated full-transcript response are
 * both preserved untouched.
 */
export function isPaginatedMessagesQuery(query: {
  paginated?: unknown;
  before?: unknown;
}): boolean {
  if (typeof query.before === 'string' && query.before.length > 0) return true;
  const p = query.paginated;
  return p === '1' || p === 'true' || p === 'yes';
}

/** Parse `?limit=` into a clamped page size; defaults when missing/invalid. */
export function parseMessagesPageSize(limitRaw: unknown): number {
  if (typeof limitRaw !== 'string') return DEFAULT_MESSAGES_PAGE_SIZE;
  const n = parseInt(limitRaw, 10);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_MESSAGES_PAGE_SIZE;
  return Math.min(n, MAX_MESSAGES_PAGE_SIZE);
}

/**
 * Parse `?before=` into a message-id cursor, or `null` for the initial
 * (newest) page. The cursor is the id of the oldest message the client has
 * already loaded; the server returns the page of messages immediately older
 * than it.
 */
export function parseBeforeMessageId(beforeRaw: unknown): string | null {
  if (typeof beforeRaw !== 'string' || beforeRaw.length === 0) return null;
  return beforeRaw;
}

/**
 * Reverse a newest-first (DESC by rowid) page into the oldest-first order the
 * UI renders. Pure helper kept separate for testability.
 */
export function toAscendingPage(rowsDesc: MessageRow[]): MessageRow[] {
  return rowsDesc.slice().reverse();
}
