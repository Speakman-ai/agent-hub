/**
 * Epic spec decisions — architecture choices captured via spike tickets/sessions
 * and injected into worker context when implementation tickets run.
 */
import crypto from 'crypto';
import type { KanbanCardRow, KanbanEpicRow, KanbanEpicSpecItemRow, Stmts } from './types.js';

export const SPEC_ITEM_STATUSES = ['open', 'chosen', 'deferred'] as const;
export type SpecItemStatus = (typeof SPEC_ITEM_STATUSES)[number];

export const CARD_KINDS = ['task', 'spike'] as const;
export type CardKind = (typeof CARD_KINDS)[number];

export function isSpikeCard(
  card: { card_kind?: string | null; title?: string | null } | null | undefined,
): boolean {
  if (!card) return false;
  if ((card.card_kind ?? 'task') === 'spike') return true;
  const title = typeof card.title === 'string' ? card.title.trim() : '';
  return title.toLowerCase().startsWith('spike:');
}

/** True when this card is the linked spike ticket for a spec item. */
export function isLinkedSpikeCard(stmts: Stmts, cardId: string): boolean {
  return getSpecItemForSpikeCard(stmts, cardId) != null;
}

export function normalizeSpecItemStatus(value: unknown): SpecItemStatus {
  return typeof value === 'string' && (SPEC_ITEM_STATUSES as readonly string[]).includes(value)
    ? (value as SpecItemStatus)
    : 'open';
}

/** Format locked spec decisions for injection into build/dispatch context. */
export function formatEpicSpecDecisionsForContext(items: KanbanEpicSpecItemRow[]): string | null {
  const chosen = items
    .filter((item) => item.status === 'chosen' && (item.decision ?? '').trim())
    .sort((a, b) => a.position - b.position || a.title.localeCompare(b.title));
  if (chosen.length === 0) return null;

  const lines = [
    '## Epic spec decisions',
    '',
    'These architecture decisions were locked during spike sessions. Follow them when implementing tickets in this epic.',
    '',
  ];
  for (const item of chosen) {
    lines.push(`### ${item.tag}: ${item.title}`);
    lines.push((item.decision ?? '').trim());
    lines.push('');
  }
  return lines.join('\n').trimEnd();
}

export function getSpecItemForSpikeCard(
  stmts: Stmts,
  spikeCardId: string,
): KanbanEpicSpecItemRow | null {
  const row = stmts.getKanbanSpecItemBySpikeCard.get(spikeCardId) as
    | KanbanEpicSpecItemRow
    | undefined;
  return row ?? null;
}

export function loadChosenSpecItemsForEpic(stmts: Stmts, epicId: string): KanbanEpicSpecItemRow[] {
  return stmts.getKanbanSpecItemsByEpic.all(epicId) as KanbanEpicSpecItemRow[];
}

export function countOpenSpecItems(stmts: Stmts, epicId: string): number {
  const row = stmts.countOpenKanbanSpecItemsByEpic.get(epicId) as { n: number } | undefined;
  return row?.n ?? 0;
}

/**
 * Open-spec count scoped to a single phase: the phase's own open spec items plus
 * epic-wide (unphased) ones. Used by the autonomous phase loop so a phase's
 * build cards dispatch once THAT phase's decisions are locked, without waiting
 * on open specs sitting in a sibling phase that has nothing to do with it.
 */
export function countOpenSpecItemsForPhase(stmts: Stmts, epicId: string, phaseId: string): number {
  const row = stmts.countOpenKanbanSpecItemsByPhase.get(epicId, phaseId) as
    | { n: number }
    | undefined;
  return row?.n ?? 0;
}

/** Derive a short spec tag from a spike card title (unique within `existingTags`). */
export function deriveSpecTagFromSpikeTitle(title: string, existingTags: Set<string>): string {
  const stripped = title.replace(/^spike:\s*/i, '').trim();
  const words = stripped.split(/\s+/).filter(Boolean);
  let base = (words.find((w) => w.length > 2) ?? words[0] ?? 'SPIKE')
    .replace(/[^a-zA-Z0-9]/g, '')
    .slice(0, 12)
    .toUpperCase();
  if (!base) base = 'SPIKE';
  let tag = base;
  let n = 2;
  while (existingTags.has(tag)) {
    tag = `${base.slice(0, Math.max(1, 12 - String(n).length))}${n}`;
    n++;
  }
  return tag;
}

export function deriveSpecTitleFromSpikeCard(title: string): string {
  return title.replace(/^spike:\s*/i, '').trim() || title.trim();
}

/**
 * Ensure a spike kanban card has a linked epic spec item (creates one when missing).
 * Spec decisions are the canonical output surface for spike research on the epic page.
 */
export function ensureSpecItemForSpikeCard(
  stmts: Stmts,
  card: KanbanCardRow,
): KanbanEpicSpecItemRow | null {
  if (!isSpikeCard(card) || !card.epic_id) return null;

  const existing = getSpecItemForSpikeCard(stmts, card.id);
  if (existing) return existing;

  const epic = stmts.getKanbanEpic.get(card.epic_id) as KanbanEpicRow | undefined;
  if (!epic) return null;

  const epicSpecItems = stmts.getKanbanSpecItemsByEpic.all(card.epic_id) as KanbanEpicSpecItemRow[];
  const existingTags = new Set(epicSpecItems.map((s) => s.tag.toUpperCase()));
  const tag = deriveSpecTagFromSpikeTitle(card.title, existingTags);
  const specTitle = deriveSpecTitleFromSpikeCard(card.title);
  const maxPos =
    epicSpecItems.length > 0 ? Math.max(...epicSpecItems.map((s) => s.position)) + 1 : 0;
  const id = crypto.randomUUID();

  stmts.createKanbanSpecItem.run(
    id,
    card.epic_id,
    epic.board_id,
    card.phase_id ?? null,
    tag,
    specTitle,
    null,
    'open',
    maxPos,
  );
  stmts.setKanbanSpecItemSpikeCard.run(card.id, id);
  if ((card.card_kind ?? 'task') !== 'spike') {
    stmts.setKanbanCardKind.run('spike', card.id);
  }
  return (stmts.getKanbanSpecItem.get(id) as KanbanEpicSpecItemRow | undefined) ?? null;
}

/** First-message context for a spike card without a linked spec item. */
export function buildSpikeSessionContextFallback(args: {
  card: KanbanCardRow;
  projectId: string;
}): string {
  const { card, projectId } = args;
  const question = deriveSpecTitleFromSpikeCard(card.title);
  const lines = [
    `# Spike: ${question}`,
    '',
    'You are running a **spike session** — research the question and **lock an architecture decision on the epic**.',
    '',
    '## Hard constraints',
    '',
    '- **No code** — do not edit files, open PRs, run Finalize, or ship anything.',
    '- **No implementation** — spikes are planning-only; workers pick up build tickets later.',
    '- **Decision output belongs on the epic** — record it as a spec decision (visible under **Spec decisions** on the epic page), not only in chat or card comments.',
    '',
    '## Your deliverable',
    '',
    '1. Investigate trade-offs for this decision.',
    '2. Create or update the matching **spec item** on the epic:',
    '',
    '```',
    `POST /api/projects/${projectId}/board/spec-items`,
    `{ "epicId": "${card.epic_id ?? '<epicId>'}", "tag": "TAG", "title": "${question}", "decision": "<clear, actionable decision text>", "status": "chosen", "phaseId": ${card.phase_id ? `"${card.phase_id}"` : 'null'} }`,
    '```',
    '',
    'If a spec item already exists for this spike, update it instead:',
    '',
    '```',
    `PUT /api/projects/${projectId}/board/spec-items/<specItemId>`,
    `{ "decision": "<clear, actionable decision text>", "status": "chosen" }`,
    '```',
    '',
    '3. Move this spike card to **Done** once the spec item is `chosen`.',
    '',
    `**Kanban card:** \`${card.id}\``,
  ];
  if (card.description?.trim()) {
    lines.splice(8, 0, `\n## Spike card notes\n${card.description.trim()}`);
  }
  return lines.join('\n');
}

/** First-message context for a spike card assignment. */
export function buildSpikeSessionContext(args: {
  card: KanbanCardRow;
  specItem: KanbanEpicSpecItemRow;
  projectId: string;
}): string {
  const { card, specItem, projectId } = args;
  const lines = [
    `# Spike: ${specItem.title}`,
    '',
    'You are running a **spike session** — research the question and **lock an architecture decision on the epic**.',
    '',
    `**Spec item:** \`${specItem.id}\` · tag \`${specItem.tag}\` (shown under **Spec decisions** on the epic page)`,
    specItem.decision?.trim()
      ? `\n## Current draft\n${specItem.decision.trim()}`
      : '\n_No decision recorded yet._',
    '',
    '## Hard constraints',
    '',
    '- **No code** — do not edit files, open PRs, run Finalize, or ship anything.',
    '- **No implementation** — spikes are planning-only.',
    '- **The decision must land on the epic spec item** — chat and card comments are not sufficient on their own.',
    '',
    '## Your deliverable',
    '',
    '1. Investigate trade-offs for this decision.',
    '2. Record the final decision on the epic spec item (this is what implementation tickets inherit):',
    '',
    '```',
    `PUT /api/projects/${projectId}/board/spec-items/${specItem.id}`,
    `{ "decision": "<clear, actionable decision text>", "status": "chosen" }`,
    '```',
    '',
    '3. Move this spike card to **Done** when the spec item is `chosen`.',
  ];
  if (card.description?.trim()) {
    lines.splice(4, 0, `\n## Spike card notes\n${card.description.trim()}`);
  }
  return lines.join('\n');
}

/** When a spec item is resolved, move the linked spike card to Done if present. */
export function completeSpikeCardForSpecItem(stmts: Stmts, specItem: KanbanEpicSpecItemRow): void {
  if (!specItem.spike_card_id) return;
  const card = stmts.getKanbanCard.get(specItem.spike_card_id) as KanbanCardRow | undefined;
  if (!card) return;
  const cols = stmts.getKanbanColumns.all(card.board_id) as Array<{ id: string; name: string }>;
  const doneCol = cols.find((c) => c.name.toLowerCase() === 'done');
  if (!doneCol || card.column_id === doneCol.id) return;
  stmts.moveKanbanCard.run(doneCol.id, 0, card.id);
}
