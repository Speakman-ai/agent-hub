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

/**
 * True when a session is a spike (or other spec-decision research) session.
 * Spike sessions may edit and run code in their worktree, but that code is
 * throwaway: the Hub's Finalize, Push, and ship actions refuse them.
 *
 * Dispatch stamps `spike_card_id` on the session, which survives the card
 * being reassigned (its `session_id` moves to the newer session). Rows that
 * predate the stamp fall back to a spec-linked scoping session, or to the card
 * currently linked to this session being a spike.
 */
export function isSpikeSession(
  stmts: Pick<Stmts, 'getKanbanCardBySession'>,
  session: {
    id: string;
    session_mode?: string | null;
    linked_spec_item_id?: string | null;
    spike_card_id?: string | null;
  },
  /** The session's card when the caller already holds it; skips the lookup. */
  knownCard?: Pick<KanbanCardRow, 'card_kind' | 'title'> | null,
): boolean {
  if ((session.spike_card_id ?? '').trim()) return true;
  if ((session.linked_spec_item_id ?? '').trim() && session.session_mode === 'scoping') {
    return true;
  }
  const card =
    knownCard !== undefined
      ? knownCard
      : (stmts.getKanbanCardBySession.get(session.id) as KanbanCardRow | undefined);
  return isSpikeCard(card);
}

export const SPIKE_SESSION_SHIP_ERROR = 'spike_session';
export const SPIKE_SESSION_SHIP_MESSAGE =
  'Spike sessions do not ship. Record the decision and findings on the spec item and build tickets; the spike code stays out of main.';

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

/**
 * Spike rules shared by both first-message builders. Spikes may write and run
 * code in their worktree to answer the question, but nothing ships, so what
 * carries forward is the decision plus file/function findings. Only the Hub's
 * Finalize, Push, and ship actions are refused; the prompt asks the agent not
 * to push or open a PR by other means.
 */
function spikeRulesAndDeliverable(args: {
  card: KanbanCardRow;
  projectId: string;
  recordDecisionLines: string[];
}): string[] {
  const { card, projectId, recordDecisionLines } = args;
  const epicRef = card.epic_id ? `\`${card.epic_id}\`` : 'the epic';
  return [
    '## Scope',
    '',
    '- **Answer the spec question, then stop.** Do not finish the feature. Build only as much as it takes to prove or disprove an option.',
    '- There is no turn, time, or token budget. The scope above is the limit.',
    '',
    '## Code rules',
    '',
    '- You **may** edit files and run code, tests, and scripts in this session worktree to try options out.',
    "- **Nothing ships.** Do not run Finalize, do not `git push`, and do not open a PR by any route. The Hub's Finalize, Push, and Create PR actions refuse spike sessions.",
    '- Treat spike code as **throwaway**. It never merges, and build tickets start from the default branch, not this worktree, so anything worth keeping must be written into the findings below.',
    '',
    '## Your deliverable',
    '',
    '1. **Decision** on the spec item:',
    ...recordDecisionLines,
    '',
    '2. **Findings** in the decision text, under a `## Findings` heading:',
    '   - What was tried.',
    '   - What broke.',
    '   - Roadblocks and open risks for the build work.',
    '',
    '3. **Code references** for the build work: the files, functions, and call sites that must be added or changed, one line each, e.g. `server/autonomous.ts` `dispatchCard`: spikes pass `wt=0`, flip for code spikes.',
    `   - Post each reference as a comment on the build ticket it applies to: \`POST /api/projects/${projectId}/board/cards/<buildCardId>/comments\` with \`{ "author": "<your agent name>", "content": "..." }\` (\`board.sh comment\`).`,
    `   - References that span several tickets go on the epic description (${epicRef}): \`PUT /api/projects/${projectId}/board/epics/${card.epic_id ?? '<epicId>'}\` with the updated \`description\`. Append; do not overwrite what is there.`,
    '',
    '4. Move this spike card to **Done** once the spec item is `chosen`.',
    '',
    `**Kanban card:** \`${card.id}\``,
  ];
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
    'You are running a **spike session**: answer this question and **lock an architecture decision on the epic**.',
    '',
    'The decision belongs on the epic as a spec decision (visible under **Spec decisions** on the epic page), not only in chat or card comments.',
    '',
  ];
  if (card.description?.trim()) {
    lines.push(`## Spike card notes\n${card.description.trim()}`, '');
  }
  lines.push(
    ...spikeRulesAndDeliverable({
      card,
      projectId,
      recordDecisionLines: [
        '',
        '```',
        `POST /api/projects/${projectId}/board/spec-items`,
        `{ "epicId": "${card.epic_id ?? '<epicId>'}", "tag": "TAG", "title": "${question}", "decision": "## Decision\\n...\\n\\n## Findings\\n...", "status": "chosen", "phaseId": ${card.phase_id ? `"${card.phase_id}"` : 'null'} }`,
        '```',
        '',
        'If a spec item already exists for this spike, update it instead:',
        '',
        '```',
        `PUT /api/projects/${projectId}/board/spec-items/<specItemId>`,
        '{ "decision": "## Decision\\n...\\n\\n## Findings\\n...", "status": "chosen" }',
        '```',
      ],
    }),
  );
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
    'You are running a **spike session**: answer this question and **lock an architecture decision on the epic**.',
    '',
  ];
  if (card.description?.trim()) {
    lines.push(`## Spike card notes\n${card.description.trim()}`, '');
  }
  lines.push(
    `**Spec item:** \`${specItem.id}\` · tag \`${specItem.tag}\` (shown under **Spec decisions** on the epic page)`,
    specItem.decision?.trim()
      ? `\n## Current draft\n${specItem.decision.trim()}`
      : '\n_No decision recorded yet._',
    '',
    ...spikeRulesAndDeliverable({
      card,
      projectId,
      recordDecisionLines: [
        '',
        '```',
        `PUT /api/projects/${projectId}/board/spec-items/${specItem.id}`,
        '{ "decision": "## Decision\\n...\\n\\n## Findings\\n...", "status": "chosen" }',
        '```',
      ],
    }),
  );
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
