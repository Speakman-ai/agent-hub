/**
 * Kanban card display helpers (web).
 *
 * Short ids ("AH-123") pair a board-level `card_prefix` (derived server-side and
 * attached to the GET /board board payload) with each card's numeric `short_id`.
 * Assignee avatars fall back to initials over a stable hashed colour when no
 * uploaded image exists (kanban assignees are free-text names, not agent rows).
 */

const FALLBACK_PREFIX = 'CARD';

/**
 * Build a card's display short id, e.g. "AH-123".
 * Returns null when the card has no `short_id` yet (legacy rows pre-backfill) so
 * callers can omit the chip rather than render "AH-null".
 */
export function cardShortLabel(prefix, shortId) {
  if (shortId == null || !Number.isFinite(Number(shortId))) return null;
  const p = (typeof prefix === 'string' && prefix.trim()) || FALLBACK_PREFIX;
  return `${p}-${shortId}`;
}

/**
 * Derive up-to-2-character initials from a free-text assignee name.
 *   "Agent Hub Dev" → "AH"   "payments" → "PA"   "x" → "X"
 * Returns '' for empty input.
 */
export function assigneeInitials(name) {
  const raw = (name ?? '').trim();
  if (!raw) return '';
  const words = raw.split(/[\s_-]+/).filter(Boolean);
  if (words.length === 0) return '';
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[1][0]).toUpperCase();
}

/**
 * A small palette of avatar background classes. Picked deterministically by a
 * stable hash of the name so the same assignee always gets the same colour.
 */
const AVATAR_PALETTE = [
  'bg-indigo-500/25 text-indigo-200',
  'bg-emerald-500/25 text-emerald-200',
  'bg-amber-500/25 text-amber-200',
  'bg-sky-500/25 text-sky-200',
  'bg-rose-500/25 text-rose-200',
  'bg-violet-500/25 text-violet-200',
  'bg-teal-500/25 text-teal-200',
  'bg-orange-500/25 text-orange-200',
];

/** Stable colour class for an assignee name (deterministic hash → palette). */
export function assigneeColorClass(name) {
  const raw = (name ?? '').trim();
  if (!raw) return AVATAR_PALETTE[0];
  let hash = 0;
  for (let i = 0; i < raw.length; i++) {
    hash = (hash * 31 + raw.charCodeAt(i)) | 0;
  }
  return AVATAR_PALETTE[Math.abs(hash) % AVATAR_PALETTE.length];
}
