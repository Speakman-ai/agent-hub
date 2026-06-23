/**
 * Kanban card display helpers (mobile).
 *
 * Mirrors the web client's `client/src/utils/kanbanCard.js` so the redesigned
 * board renders the same dense card (short id, priority glyph, assignee avatar,
 * date, status glyphs) within React Native constraints. The web version returns
 * Tailwind class strings; here the colour helpers return raw hex/`{bg,text}`
 * pairs because RN has no class system.
 *
 * `cardMetaModel` is the pure "card-meta formatting" helper the card component
 * consumes — it normalises a raw card row into the fields the dense layout
 * draws, so the renderer stays declarative and the formatting is unit-testable.
 */
import { findEpic } from './epics';
const FALLBACK_PREFIX = 'CARD';
export const PRIORITIES = ['urgent', 'high', 'medium', 'low'];
// Colours match the web PRIORITY accents and the screen's PRIORITY_OPTIONS.
const PRIORITY_META: Record<string, any> = {
    urgent: { label: 'Urgent', color: '#EF4444' },
    high: { label: 'High', color: '#F97316' },
    medium: { label: 'Medium', color: '#3B82F6' },
    low: { label: 'Low', color: '#6B7280' },
};
/** Priority `{ value, label, color }`, defaulting to medium for unknown input. */
export function priorityMeta(value: any) {
    const v = value && PRIORITY_META[value] ? value : 'medium';
    return { value: v, ...PRIORITY_META[v] };
}
// Review-status glyph metadata (mirrors the web ReviewGlyph map).
const REVIEW_META: Record<string, any> = {
    approved: { label: 'Approved', color: '#34D399' },
    reviewing: { label: 'Reviewing', color: '#FBBF24' },
    changes_requested: { label: 'Changes', color: '#F87171' },
    awaiting_review: { label: 'Review', color: '#93C5FD' },
};
/** Review `{ label, color }` for a status, or null when there's nothing to show. */
export function reviewMeta(status: any) {
    return REVIEW_META[status] || null;
}
/**
 * Build a card's display short id, e.g. "AH-123". Returns null when the card has
 * no `short_id` yet (legacy rows pre-backfill) so callers can omit the chip
 * rather than render "AH-null".
 */
export function cardShortLabel(prefix: any, shortId: any) {
    if (shortId == null || !Number.isFinite(Number(shortId)))
        return null;
    const p = (typeof prefix === 'string' && prefix.trim()) || FALLBACK_PREFIX;
    return `${p}-${shortId}`;
}
/**
 * Derive up-to-2-character initials from a free-text assignee name.
 *   "Agent Hub Dev" -> "AH"   "payments" -> "PA"   "x" -> "X"
 * Returns '' for empty input.
 */
export function assigneeInitials(name: any) {
    const raw = (name ?? '').trim();
    if (!raw)
        return '';
    const words = raw.split(/[\s_-]+/).filter(Boolean);
    if (words.length === 0)
        return '';
    if (words.length === 1)
        return words[0].slice(0, 2).toUpperCase();
    return (words[0][0] + words[1][0]).toUpperCase();
}
/**
 * A small palette of avatar colours. Picked deterministically by a stable hash
 * of the name so the same assignee always gets the same colour. Each entry is a
 * `{ bg, text }` pair (translucent background + readable foreground).
 */
const AVATAR_PALETTE = [
    { bg: 'rgba(99,102,241,0.25)', text: '#C7D2FE' }, // indigo
    { bg: 'rgba(16,185,129,0.25)', text: '#A7F3D0' }, // emerald
    { bg: 'rgba(245,158,11,0.25)', text: '#FDE68A' }, // amber
    { bg: 'rgba(14,165,233,0.25)', text: '#BAE6FD' }, // sky
    { bg: 'rgba(244,63,94,0.25)', text: '#FECDD3' }, // rose
    { bg: 'rgba(139,92,246,0.25)', text: '#DDD6FE' }, // violet
    { bg: 'rgba(20,184,166,0.25)', text: '#99F6E4' }, // teal
    { bg: 'rgba(249,115,22,0.25)', text: '#FED7AA' }, // orange
];
/** Stable avatar `{ bg, text }` for an assignee name (deterministic hash). */
export function assigneeColors(name: any) {
    const raw = (name ?? '').trim();
    if (!raw)
        return AVATAR_PALETTE[0];
    let hash = 0;
    for (let i = 0; i < raw.length; i++) {
        hash = (hash * 31 + raw.charCodeAt(i)) | 0;
    }
    return AVATAR_PALETTE[Math.abs(hash) % AVATAR_PALETTE.length];
}
/**
 * Build a shareable card deep-link, matching the web card menu's
 * `${window.location.origin}/projects/:projectId/board?card=:cardId`. `baseUrl`
 * is the server root (no `/api`, no trailing slash) — the same origin that
 * serves the web client. Returns null when no base URL is configured yet, so
 * the caller can fall back rather than copy a non-pasteable relative string.
 */
export function cardShareUrl(baseUrl: any, projectId: any, cardId: any) {
    const root = (baseUrl ?? '').trim().replace(/\/+$/, '');
    if (!root || !projectId || cardId == null)
        return null;
    return `${root}/projects/${projectId}/board?card=${cardId}`;
}
/** Card labels (string "a,b" or array) -> trimmed non-empty string array. */
export function cardLabelList(labels: any) {
    if (!labels)
        return [];
    const arr = Array.isArray(labels) ? labels : String(labels).split(',');
    return arr.map((l: any) => String(l).trim()).filter(Boolean);
}
/**
 * Toggle a single label on/off and return the resulting comma-joined string
 * (the shape `updateKanbanCard` persists). Pure, so chaining is well-defined:
 * feeding the previous result back in accumulates selections —
 *   toggleLabelCsv(toggleLabelCsv('', 'bug'), 'ui') === 'bug,ui'
 * which is exactly the multi-toggle case the action sheet relies on. Existing
 * labels are de-duplicated and trimmed.
 */
export function toggleLabelCsv(labelsInput: any, label: any) {
    const current = cardLabelList(labelsInput);
    const next = current.includes(label)
        ? current.filter((l: any) => l !== label)
        : [...current, label];
    return next.join(',');
}
/** Count of unresolved (`!done`) blockers on a card. */
function unresolvedBlockerCount(card: any) {
    if (!Array.isArray(card?.blockers))
        return 0;
    return card.blockers.filter((b: any) => !b.done).length;
}
/** PR number parsed from a trailing integer in `pr_url`, else 'PR' when set. */
function prNumber(prUrl: any) {
    if (!prUrl)
        return null;
    return String(prUrl).match(/\d+$/)?.[0] || 'PR';
}
/**
 * Normalise a raw card row into the fields the dense mobile card renders.
 * Pure: same inputs -> same output (no Date.now / no rendering). Date display
 * is left to the `time` util so this stays deterministic.
 */
export function cardMetaModel(card: any, { board, epics = [] }: any = {}) {
    const epic = card?.epic_id ? findEpic(epics, card.epic_id) || null : null;
    return {
        shortLabel: cardShortLabel(board?.card_prefix, card?.short_id),
        priority: priorityMeta(card?.priority),
        assignee: card?.assignee || null,
        initials: assigneeInitials(card?.assignee),
        avatar: assigneeColors(card?.assignee),
        active: !!card?.session_id,
        epic,
        labels: cardLabelList(card?.labels),
        blockerCount: unresolvedBlockerCount(card),
        prNumber: prNumber(card?.pr_url),
        prUrl: card?.pr_url || null,
        review: reviewMeta(card?.review_status),
        // Set when the card's working session was closed but the card had
        // progressed too far to garbage-collect — flagged for human attention.
        orphaned: !!card?.orphaned_at,
        createdAt: card?.created_at || null,
    };
}
