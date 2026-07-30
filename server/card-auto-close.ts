import { v4 as uuidv4 } from 'uuid';
import type { Stmts, BroadcastFn, KanbanCardRow, KanbanColumnRow } from './types.js';
import { extractJsonFromTagBody } from './action-block-parsing.js';
import { recomputeSessionState } from './session-state.js';

// ─── Kanban card auto-close — `<agenthub:close-card>` block protocol ─────────
//
// When an agent picks up a card and discovers the work is redundant — either
// because an earlier ticket already covered the same scope (a duplicate) or
// because the work has already landed in the codebase (already done) — it
// should not silently leave the card parked. Instead it emits a structured
// block at the end of its turn:
//
//   <agenthub:close-card>
//   {"reason": "duplicate", "note": "Covered by card 5c8f — see PR #313",
//    "duplicateOfCardId": "5c8f...-..."}
//   </agenthub:close-card>
//
// The server parses this from the final assistant message after the CLI
// process closes, looks up
// the card linked to the current session via `kanban_cards.session_id`,
// moves it to the Done column, and drops an explanatory comment on the
// card referencing the session. All of it is best-effort: if anything
// fails (missing card, no Done column, DB error) the main chat flow is
// unaffected.
//
// Fields:
//   - `reason` (required): "duplicate" | "already-done"
//   - `note` (required): one-line explanation shown in the auto-close comment
//   - `duplicateOfCardId` (optional): canonical card id to link when the
//     card is a duplicate. Rendered as a reference in the comment body.

export type CloseCardReason = 'duplicate' | 'already-done';

export interface CloseCardTask {
  reason: CloseCardReason;
  note: string;
  duplicateOfCardId?: string;
}

export type CloseCardMalformedReason =
  | 'invalid-json'
  | 'not-object'
  | 'missing-reason'
  | 'invalid-reason'
  | 'missing-note'
  | 'empty-note';

export interface CloseCardDetectionResult {
  present: boolean;
  task: CloseCardTask | null;
  reason: CloseCardMalformedReason | null;
  rawBody: string | null;
}

export interface CardAutoCloseResult {
  cardId: string;
  previousColumnId: string;
  doneColumnId: string;
  commentId: string;
}

/** Why {@link handleCardAutoClose} could not complete when `ok` is false. */
export type CardAutoCloseFailureReason =
  | 'card_lookup_failed'
  | 'no_linked_card'
  | 'column_lookup_failed'
  | 'no_done_column'
  | 'move_failed';

export type CardAutoCloseOutcome =
  | { ok: true; result: CardAutoCloseResult }
  | { ok: false; reason: CardAutoCloseFailureReason };

export interface CardAutoCloseDeps {
  stmts: Stmts;
  broadcast: BroadcastFn;
  projectId: string;
  /** Author string stamped on the auto-generated comment. */
  author?: string;
}

// ─── Parser ──────────────────────────────────────────────────────────────

/**
 * Extract an `<agenthub:close-card>...</agenthub:close-card>` block from
 * `text` and return the parsed task. Returns `null` if no block is found,
 * the JSON is malformed, or the required fields (`reason`, `note`) are
 * missing, empty, or invalid.
 *
 * Accepts either the canonical `already-done` or the common typo
 * `already_done` / `alreadyDone` as the reason — normalized to
 * `already-done`. Anything else is rejected.
 *
 * Only the first block in `text` is considered.
 *
 * Exported for tests.
 */
export function detectCloseCardBlock(text: string): CloseCardDetectionResult {
  if (typeof text !== 'string') {
    return { present: false, task: null, reason: null, rawBody: null };
  }
  const match = text.match(/<agenthub:close-card>\s*([\s\S]*?)\s*<\/agenthub:close-card>/);
  if (!match) return { present: false, task: null, reason: null, rawBody: null };
  const rawBody = match[1] ?? '';
  // Tolerate fenced wrappers (```json ... ```), prose before/after the JSON
  // payload, and raw newlines inside string values. Each of those used to
  // hard-fail with a silent `invalid-json` before reaching the typed
  // validation gate. See `action-block-parsing.ts`.
  const normalized = extractJsonFromTagBody(rawBody);
  let parsed: unknown;
  try {
    parsed = normalized === null ? JSON.parse(rawBody) : JSON.parse(normalized);
  } catch {
    return { present: true, task: null, reason: 'invalid-json', rawBody };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { present: true, task: null, reason: 'not-object', rawBody };
  }
  const obj = parsed as Record<string, unknown>;

  const rawReason = typeof obj.reason === 'string' ? obj.reason.trim().toLowerCase() : '';
  let reason: CloseCardReason | null = null;
  if (!rawReason) return { present: true, task: null, reason: 'missing-reason', rawBody };
  if (rawReason === 'duplicate') reason = 'duplicate';
  else if (
    rawReason === 'already-done' ||
    rawReason === 'already_done' ||
    rawReason === 'alreadydone' ||
    rawReason === 'done'
  )
    reason = 'already-done';
  if (!reason) return { present: true, task: null, reason: 'invalid-reason', rawBody };

  const note = typeof obj.note === 'string' ? obj.note.trim() : '';
  if (typeof obj.note !== 'string') {
    return { present: true, task: null, reason: 'missing-note', rawBody };
  }
  if (!note) return { present: true, task: null, reason: 'empty-note', rawBody };

  const duplicateOfCardIdRaw =
    typeof obj.duplicateOfCardId === 'string'
      ? obj.duplicateOfCardId.trim()
      : typeof obj.duplicate_of_card_id === 'string'
        ? (obj.duplicate_of_card_id as string).trim()
        : '';
  const duplicateOfCardId = duplicateOfCardIdRaw || undefined;

  const task: CloseCardTask = duplicateOfCardId
    ? { reason, note, duplicateOfCardId }
    : { reason, note };
  return { present: true, task, reason: null, rawBody };
}

export function describeCloseCardReason(reason: CloseCardMalformedReason): string {
  switch (reason) {
    case 'invalid-json':
      return 'Close-card block contains invalid JSON';
    case 'not-object':
      return 'Close-card block payload is not a JSON object';
    case 'missing-reason':
      return 'Close-card block is missing the "reason" field';
    case 'invalid-reason':
      return 'Close-card block has an invalid "reason" value';
    case 'missing-note':
      return 'Close-card block is missing the "note" field';
    case 'empty-note':
      return 'Close-card block has an empty "note" value';
    default:
      return 'Close-card block could not be parsed';
  }
}

export function parseCloseCardBlock(text: string): CloseCardTask | null {
  return detectCloseCardBlock(text).task;
}

// ─── Comment body rendering ──────────────────────────────────────────────

/**
 * Render the comment appended to an auto-closed card. Pure function —
 * exported for tests so the exact surface the user sees is pinned down.
 */
export function buildAutoCloseCommentBody(args: {
  task: CloseCardTask;
  sessionId: string;
  duplicateCardTitle?: string;
}): string {
  const { task, sessionId, duplicateCardTitle } = args;
  const reasonLabel = task.reason === 'duplicate' ? 'duplicate' : 'already done';
  const lines: string[] = [`🔁 Auto-closed by agent — reason: **${reasonLabel}**.`, '', task.note];
  if (task.reason === 'duplicate' && task.duplicateOfCardId) {
    const label = duplicateCardTitle
      ? `"${duplicateCardTitle}" (\`${task.duplicateOfCardId}\`)`
      : `\`${task.duplicateOfCardId}\``;
    lines.push('', `Duplicate of: ${label}`);
  }
  lines.push('', `— session \`${sessionId}\``);
  return lines.join('\n');
}

// ─── Done-column resolution ──────────────────────────────────────────────

/**
 * Given the columns of a board, pick the one that represents "done" work.
 * Preference:
 *   1. Case-insensitive exact match on "done".
 *   2. Case-insensitive name containing "done".
 *   3. The rightmost column (highest `position`).
 * Returns `null` only when `columns` is empty.
 *
 * Exported for tests.
 */
export function pickDoneColumn(columns: readonly KanbanColumnRow[]): KanbanColumnRow | null {
  if (!Array.isArray(columns) || columns.length === 0) return null;
  const exact = columns.find((c) => (c.name || '').trim().toLowerCase() === 'done');
  if (exact) return exact;
  const contains = columns.find((c) => (c.name || '').toLowerCase().includes('done'));
  if (contains) return contains;
  return columns.slice().sort((a, b) => b.position - a.position)[0] ?? null;
}

// ─── Handler ─────────────────────────────────────────────────────────────

/**
 * Move the card linked to `sessionId` into the board's Done column and
 * append an explanatory comment. Returns `{ ok: false, reason }` when the
 * session has no linked card, lookups fail, there is no Done column, or the
 * move fails. When the card is already in Done, `{ ok: true }` is still
 * returned after recording the audit comment.
 *
 * Best-effort: all exceptions are caught and logged; the function never
 * throws. Callers typically invoke this from the post-stream hook in
 * `chat.ts` and do not await the result.
 */
export function handleCardAutoClose(
  sessionId: string,
  task: CloseCardTask,
  deps: CardAutoCloseDeps,
): CardAutoCloseOutcome {
  const { stmts, broadcast, projectId, author } = deps;

  let card: KanbanCardRow | undefined;
  try {
    card = stmts.getKanbanCardBySession.get(sessionId) as KanbanCardRow | undefined;
  } catch (err) {
    console.error('[CardAutoClose] Card lookup failed:', (err as Error).message);
    return { ok: false, reason: 'card_lookup_failed' };
  }
  if (!card) return { ok: false, reason: 'no_linked_card' };

  let columns: KanbanColumnRow[] = [];
  try {
    columns = stmts.getKanbanColumns.all(card.board_id) as KanbanColumnRow[];
  } catch (err) {
    console.error('[CardAutoClose] Column lookup failed:', (err as Error).message);
    return { ok: false, reason: 'column_lookup_failed' };
  }
  const doneColumn = pickDoneColumn(columns);
  if (!doneColumn) return { ok: false, reason: 'no_done_column' };

  // If the card is already in Done, there's nothing to move — but still
  // drop the comment so the audit trail captures the agent's reasoning.
  const previousColumnId = card.column_id;
  if (previousColumnId !== doneColumn.id) {
    try {
      stmts.moveKanbanCard.run(doneColumn.id, 0, card.id);
    } catch (err) {
      console.error('[CardAutoClose] Move failed:', (err as Error).message);
      return { ok: false, reason: 'move_failed' };
    }
  }

  let duplicateCardTitle: string | undefined;
  if (task.duplicateOfCardId) {
    try {
      const other = stmts.getKanbanCard.get(task.duplicateOfCardId) as KanbanCardRow | undefined;
      if (other?.title) duplicateCardTitle = other.title;
    } catch {
      /* best-effort title lookup only */
    }
  }

  const commentId = uuidv4();
  const body = buildAutoCloseCommentBody({ task, sessionId, duplicateCardTitle });
  try {
    stmts.createKanbanCardComment.run(commentId, card.id, author || 'agent-hub', body);
  } catch (err) {
    console.error('[CardAutoClose] Comment insert failed:', (err as Error).message);
    // Still report the move as successful — the card did get closed.
  }

  try {
    broadcast({ type: 'kanban_update', projectId });
  } catch {
    /* broadcast failures should never surface */
  }

  // The linked card just landed in Done — the session's resolved state flips to
  // `merged` (Done-column membership is the durable local merge signal). Persist
  // it and push `session_state` so the sidebar icon updates live without a
  // refetch. Best-effort; never blocks the close result.
  recomputeSessionState(stmts, sessionId, { agentId: author ?? null, broadcast });

  return {
    ok: true,
    result: {
      cardId: card.id,
      previousColumnId,
      doneColumnId: doneColumn.id,
      commentId,
    },
  };
}
