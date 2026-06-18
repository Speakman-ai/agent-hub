/**
 * Keyset (cursor) pagination helpers for per-column kanban card fetches.
 *
 * Cards within a column are ordered by `(position ASC, id ASC)`. A cursor
 * captures the last `{position, id}` a client has seen so the next page can
 * resume strictly after it. Keyset beats offset here because To-Do cards get
 * reordered mid-scroll: an offset would skip or duplicate rows when positions
 * shift under the client, whereas a `(position, id)` cursor always resumes at
 * a stable point in the ordering.
 *
 * The cursor is an opaque base64url token on the wire — clients should treat
 * it as a blob and echo back whatever `nextCursor` the server returned.
 */

export interface CardCursor {
  position: number;
  id: string;
}

/** Default per-column page size when the caller omits `limit`. */
export const DEFAULT_CARD_PAGE_SIZE = 50;

/** Hard ceiling on `limit` so a single request can't pull an unbounded slice. */
export const MAX_CARD_PAGE_SIZE = 200;

/**
 * Encode a `{position, id}` cursor as an opaque base64url token.
 *
 * The plain form is `"<position>:<id>"`. `id` is a UUID (no colon), and
 * `position` is an integer, so the first colon unambiguously splits the two
 * halves on decode.
 */
export function encodeCardCursor(cursor: CardCursor): string {
  return Buffer.from(`${cursor.position}:${cursor.id}`, 'utf8').toString('base64url');
}

/**
 * Decode a base64url cursor token back into `{position, id}`. Returns `null`
 * for any malformed input (bad base64, missing colon, non-integer position,
 * empty id) so callers can reject it with a 400 rather than throwing.
 */
export function decodeCardCursor(raw: string): CardCursor | null {
  if (!raw) return null;
  let decoded: string;
  try {
    decoded = Buffer.from(raw, 'base64url').toString('utf8');
  } catch {
    return null;
  }
  const idx = decoded.indexOf(':');
  if (idx < 0) return null;
  const posStr = decoded.slice(0, idx);
  const id = decoded.slice(idx + 1);
  if (!id) return null;
  // Number('') === 0, so guard the empty case explicitly before parsing.
  if (posStr.trim() === '') return null;
  const position = Number(posStr);
  if (!Number.isInteger(position)) return null;
  return { position, id };
}

/**
 * Normalize a raw `limit` query value into a safe integer in
 * `[1, MAX_CARD_PAGE_SIZE]`. Missing / non-numeric / out-of-range values fall
 * back to `DEFAULT_CARD_PAGE_SIZE` (missing) or the nearest bound (clamped).
 */
export function clampPageLimit(raw: unknown): number {
  if (raw === undefined || raw === null || raw === '') return DEFAULT_CARD_PAGE_SIZE;
  const n = Number(Array.isArray(raw) ? raw[0] : raw);
  if (!Number.isFinite(n)) return DEFAULT_CARD_PAGE_SIZE;
  const floored = Math.floor(n);
  if (floored < 1) return 1;
  if (floored > MAX_CARD_PAGE_SIZE) return MAX_CARD_PAGE_SIZE;
  return floored;
}
