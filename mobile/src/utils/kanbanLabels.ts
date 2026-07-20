// Pure label helpers for kanban cards/epics (mobile).
// Mirrors client/src/utils/kanbanLabels.ts so web and mobile agree on how a
// comma-separated labels field splits, dedupes, and filters.

/** Split a card's comma-separated labels field into trimmed, non-empty tags. */
export function parseCardLabels(raw: string | null | undefined): string[] {
  if (!raw) return [];
  return String(raw)
    .split(',')
    .map((label) => label.trim())
    .filter(Boolean);
}

/** Distinct labels across cards, sorted for display. */
export function collectDistinctLabels(cards: Array<{ labels?: string | null }>): string[] {
  const set = new Set<string>();
  for (const card of cards) {
    for (const label of parseCardLabels(card.labels)) set.add(label);
  }
  return [...set].sort((a, b) => a.localeCompare(b));
}

/** OR semantics: empty selection matches every card. */
export function cardMatchesLabelFilter(
  card: { labels?: string | null },
  selectedLabels: Set<string>,
): boolean {
  if (selectedLabels.size === 0) return true;
  return parseCardLabels(card.labels).some((label) => selectedLabels.has(label));
}
