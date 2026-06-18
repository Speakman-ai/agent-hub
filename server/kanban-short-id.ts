/**
 * Human-readable kanban card short ids ("AH-123").
 *
 * Each card carries a monotonic per-board number (`kanban_cards.short_id`,
 * assigned by a DB trigger). The display label pairs that number with a short
 * alphabetic prefix — Linear-style (`MCS-1688`). The prefix is persisted on the
 * board (`kanban_boards.card_prefix`), frozen at creation by deriving it from
 * the immutable project id/slug via `deriveCardPrefix` below. Persisting it (vs.
 * re-deriving from the mutable display name on every load) keeps already-shared
 * card ids stable across a project rename.
 */

const FALLBACK_PREFIX = 'CARD';
const MAX_PREFIX_LEN = 4;

/**
 * Assign-on-insert trigger for `kanban_cards.short_id`. Runs synchronously
 * inside the INSERT, so the row read back by the route already carries its
 * short_id. Guarded on `NEW.short_id IS NULL` so an explicit value (e.g. a
 * future import path) wins and the one-time backfill never re-triggers it.
 *
 * Shared between the DB migration (server/db.ts) and the reconcile regression
 * test so both exercise identical SQL.
 */
export const KANBAN_CARD_SHORT_ID_TRIGGER_SQL = `
  CREATE TRIGGER IF NOT EXISTS kanban_card_assign_short_id
  AFTER INSERT ON kanban_cards
  FOR EACH ROW WHEN NEW.short_id IS NULL
  BEGIN
    UPDATE kanban_boards SET card_seq = card_seq + 1 WHERE id = NEW.board_id;
    UPDATE kanban_cards
       SET short_id = (SELECT card_seq FROM kanban_boards WHERE id = NEW.board_id)
     WHERE id = NEW.id;
  END;
`;

/**
 * Reconcile every board's `card_seq` up to its highest assigned `short_id`.
 *
 * Run unconditionally on every init: it is idempotent and self-healing. If a
 * prior process was interrupted after the short_id backfill committed but
 * before `card_seq` advanced (a non-atomic two-statement window in an earlier
 * version), this repairs `card_seq` on the next startup so the trigger's next
 * number can never collide with an existing short_id. Uses the scalar
 * `MAX(card_seq, …)` so it only ever RAISES `card_seq`, never lowers it:
 * deleting cards leaves `MAX(short_id) < card_seq`, and lowering would reuse a
 * retired, possibly-shared human id.
 */
export const KANBAN_BOARD_CARD_SEQ_RECONCILE_SQL = `
  UPDATE kanban_boards
     SET card_seq = MAX(
       card_seq,
       COALESCE(
         (SELECT MAX(short_id) FROM kanban_cards WHERE kanban_cards.board_id = kanban_boards.id),
         0
       )
     );
`;

/**
 * Derive a short uppercase alphabetic-ish prefix from a project name or slug.
 *
 * Rules:
 *   - Split into words on whitespace / punctuation and camelCase boundaries.
 *   - Multi-word → initials of the first up-to-4 words ("agent-hub" → "AH",
 *     "Acme Web Platform" → "AWP").
 *   - Single word → its first 3 letters uppercased ("payments" → "PAY").
 *   - Always uppercase, alphanumeric only, 2–4 chars.
 *   - Empty / punctuation-only input → "CARD".
 */
export function deriveCardPrefix(nameOrId: string | null | undefined): string {
  const raw = (nameOrId ?? '').trim();
  if (!raw) return FALLBACK_PREFIX;

  const words = raw
    // insert a boundary between camelCase humps: "agentHub" → "agent Hub"
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean);

  if (words.length === 0) return FALLBACK_PREFIX;

  let prefix: string;
  if (words.length === 1) {
    prefix = words[0].slice(0, 3);
  } else {
    prefix = words
      .slice(0, MAX_PREFIX_LEN)
      .map((w) => w[0])
      .join('');
  }

  prefix = prefix.replace(/[^A-Za-z0-9]/g, '').toUpperCase();

  // Guarantee at least 2 chars so the label never collapses to "A-1".
  if (prefix.length < 2) {
    prefix = words[0]
      .replace(/[^A-Za-z0-9]/g, '')
      .slice(0, 3)
      .toUpperCase();
  }
  if (prefix.length < 2) return FALLBACK_PREFIX;

  return prefix.slice(0, MAX_PREFIX_LEN);
}

/**
 * Build the full display label for a card given the board prefix and the card's
 * numeric short id. Returns null when the card has no short id yet (legacy rows
 * pre-backfill) so callers can omit the chip rather than render "AH-null".
 */
export function formatCardShortId(
  prefix: string | null | undefined,
  shortId: number | null | undefined,
): string | null {
  if (shortId == null || !Number.isFinite(shortId)) return null;
  const p = (prefix && prefix.trim()) || FALLBACK_PREFIX;
  return `${p}-${shortId}`;
}
