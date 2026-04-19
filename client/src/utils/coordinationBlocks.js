/**
 * Parser for agent-coordination blocks emitted in assistant messages.
 *
 * The server recognises two protocol blocks in the *final* assistant text:
 *
 *   <handoff>{"toAgent": "...", "note": "..."}</handoff>
 *     — transfers ownership of the session to another agent (terminal).
 *
 *   <delegate>[{"agentId": "...", "task": "..."}, ...]</delegate>
 *     — spawns one or more parallel sub-agent sessions (lead keeps running).
 *
 * The canonical delegate field is `agentId` (matches the prompt wired in
 * `server/chat.ts` and the validator in `server/delegation.ts`). Earlier
 * iterations of this helper used `toAgent`; we still accept that as a
 * tolerant alias so in-flight messages / mis-schooled agents still strip
 * cleanly. See `server/delegation.ts#parseDelegateBlock` for the source of
 * truth.
 *
 * This module gives the renderer:
 *   - parseHandoffBlock(text)      → { toAgent, note } | null
 *   - parseDelegateBlock(text)     → Array<{ agentId, task }> | null
 *   - detectHandoffBlock(text)     → { present, task, reason, rawBody }
 *   - detectDelegateBlock(text)    → { present, tasks, reason, rawBody }
 *   - extractCoordinationBlocks(text)
 *       → { stripped, handoff, delegate, handoffMalformed, delegateMalformed }
 *     so the rendered text can be the conversational prose alone, with the
 *     coordination intent shown as a dedicated card. Malformed blocks are
 *     also stripped from the prose and surfaced as failed-state cards so
 *     raw JSON never leaks into the chat.
 *
 * The parsers are intentionally tolerant of whitespace and of occasional
 * stream-fragment edge cases. They return `null` (not throw) on malformed
 * input so a partially-streamed block never crashes the chat.
 */

const HANDOFF_RE = /<handoff>\s*([\s\S]*?)\s*<\/handoff>/;
const DELEGATE_RE = /<delegate>\s*([\s\S]*?)\s*<\/delegate>/;

/**
 * Detect a `<handoff>` block in `text` and return a tagged result:
 *   { present, task, reason, rawBody }
 * where `task` is non-null only when the block parsed cleanly, and `reason`
 * explains *why* a present block failed. Mirrors
 * `server/handoff.ts#detectHandoffBlock` so the web UI can distinguish
 * "no block" from "malformed block" and still render a failed-state
 * HandoffCard instead of silently dropping the handoff.
 *
 * Reason codes:
 *   'invalid-json' — body is not valid JSON
 *   'not-object'   — body parsed but is not a JSON object
 *   'array-payload'— body is an array (handoff is single-target)
 *   'missing-toagent' / 'missing-note' — field not present
 *   'empty-toagent'  / 'empty-note'     — field present but blank
 */
export function detectHandoffBlock(text) {
  if (typeof text !== 'string' || !text.includes('<handoff>')) {
    return { present: false, task: null, reason: null, rawBody: null };
  }
  const match = text.match(HANDOFF_RE);
  if (!match) {
    return { present: false, task: null, reason: null, rawBody: null };
  }
  const rawBody = match[1] ?? '';
  let parsed;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return { present: true, task: null, reason: 'invalid-json', rawBody };
  }
  if (!parsed || typeof parsed !== 'object') {
    return { present: true, task: null, reason: 'not-object', rawBody };
  }
  if (Array.isArray(parsed)) {
    return { present: true, task: null, reason: 'array-payload', rawBody };
  }
  if (typeof parsed.toAgent !== 'string') {
    return { present: true, task: null, reason: 'missing-toagent', rawBody };
  }
  if (typeof parsed.note !== 'string') {
    return { present: true, task: null, reason: 'missing-note', rawBody };
  }
  const toAgent = parsed.toAgent.trim();
  const note = parsed.note.trim();
  if (!toAgent) return { present: true, task: null, reason: 'empty-toagent', rawBody };
  if (!note) return { present: true, task: null, reason: 'empty-note', rawBody };
  return { present: true, task: { toAgent, note }, reason: null, rawBody };
}

const HANDOFF_REASON_MESSAGES = {
  'invalid-json': 'Handoff block contains invalid JSON',
  'not-object': 'Handoff block payload is not a JSON object',
  'array-payload': 'Handoff block payload is an array (handoff is single-target)',
  'missing-toagent': 'Handoff block is missing the "toAgent" field',
  'missing-note': 'Handoff block is missing the "note" field',
  'empty-toagent': 'Handoff block has an empty "toAgent" field',
  'empty-note': 'Handoff block has an empty "note" field',
};

/**
 * Human-readable label for a detection reason — mirrors the server's
 * `describeHandoffReason` so both paths surface the same error text.
 */
export function describeHandoffReason(reason) {
  return HANDOFF_REASON_MESSAGES[reason] || 'Handoff block could not be parsed';
}

/**
 * Parse a `<handoff>` block out of `text`. Returns the parsed task or null
 * if the block is missing, malformed, or missing required fields. Matches
 * the validation in `server/handoff.ts#parseHandoffBlock`.
 */
export function parseHandoffBlock(text) {
  return detectHandoffBlock(text).task;
}

/**
 * Detect a `<delegate>` block in `text` and return a tagged result:
 *   { present, tasks, reason, rawBody }
 * where `tasks` is a non-empty array only when the block parsed cleanly,
 * and `reason` explains *why* a present block failed. Mirrors
 * `detectHandoffBlock` so the UI can distinguish "no block" from
 * "malformed block" and render a failed-state `DelegateCard` instead of
 * silently dropping the delegation — the previous behaviour was the root
 * cause of the "delegate sometimes doesn't show up" bug when WebSocket
 * events for successful dispatches were delayed or dropped.
 *
 * Reason codes:
 *   'invalid-json'       — body is not valid JSON
 *   'not-object'         — body parsed but is neither object nor array
 *   'empty-array'        — body is `[]`
 *   'no-valid-entries'   — every entry is missing `agentId` or `task`
 */
export function detectDelegateBlock(text) {
  if (typeof text !== 'string' || !text.includes('<delegate>')) {
    return { present: false, tasks: null, reason: null, rawBody: null };
  }
  const match = text.match(DELEGATE_RE);
  if (!match) {
    return { present: false, tasks: null, reason: null, rawBody: null };
  }
  const rawBody = match[1] ?? '';
  let parsed;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return { present: true, tasks: null, reason: 'invalid-json', rawBody };
  }
  if (parsed == null || (typeof parsed !== 'object' && !Array.isArray(parsed))) {
    return { present: true, tasks: null, reason: 'not-object', rawBody };
  }
  const list = Array.isArray(parsed) ? parsed : [parsed];
  if (list.length === 0) {
    return { present: true, tasks: null, reason: 'empty-array', rawBody };
  }
  const tasks = [];
  for (const entry of list) {
    if (!entry || typeof entry !== 'object') continue;
    const rawAgentId =
      typeof entry.agentId === 'string'
        ? entry.agentId
        : typeof entry.toAgent === 'string'
          ? entry.toAgent
          : '';
    const agentId = rawAgentId.trim();
    const task = typeof entry.task === 'string' ? entry.task.trim() : '';
    if (!agentId || !task) continue;
    tasks.push({ agentId, task });
  }
  if (tasks.length === 0) {
    return { present: true, tasks: null, reason: 'no-valid-entries', rawBody };
  }
  return { present: true, tasks, reason: null, rawBody };
}

const DELEGATE_REASON_MESSAGES = {
  'invalid-json': 'Delegate block contains invalid JSON',
  'not-object': 'Delegate block payload is not a JSON object or array',
  'empty-array': 'Delegate block payload is an empty array',
  'no-valid-entries': 'Delegate block has no entries with both "agentId" and "task"',
};

/**
 * Human-readable label for a delegate detection reason code.
 */
export function describeDelegateReason(reason) {
  return DELEGATE_REASON_MESSAGES[reason] || 'Delegate block could not be parsed';
}

/**
 * Parse a `<delegate>` block. Returns an array of `{agentId, task}` entries
 * (single-object blocks are coerced to a 1-element array) or null on missing
 * / malformed input. Mirrors `server/delegation.ts#parseDelegateBlock`.
 *
 * Field names: the canonical target field is `agentId`; we also accept
 * `toAgent` as a tolerant alias so messages authored before the schemas
 * were aligned still strip cleanly in the chat UI.
 */
export function parseDelegateBlock(text) {
  return detectDelegateBlock(text).tasks;
}

/**
 * Strip both kinds of coordination blocks (and any incidental whitespace they
 * leave behind) from `text`. Returns the cleaned prose plus the parsed blocks
 * so a renderer can show the prose as markdown and the blocks as cards.
 *
 * Leaves the input untouched (and `handoff`/`delegate` null) when no blocks
 * are present.
 */
export function extractCoordinationBlocks(text) {
  if (typeof text !== 'string' || text.length === 0) {
    return {
      stripped: text ?? '',
      handoff: null,
      delegate: null,
      handoffMalformed: null,
      delegateMalformed: null,
    };
  }

  const handoffDetection = detectHandoffBlock(text);
  const handoff = handoffDetection.task;
  const handoffMalformed =
    handoffDetection.present && !handoffDetection.task
      ? { reason: handoffDetection.reason, rawBody: handoffDetection.rawBody ?? '' }
      : null;

  const delegateDetection = detectDelegateBlock(text);
  const delegate = delegateDetection.tasks;
  const delegateMalformed =
    delegateDetection.present && !delegateDetection.tasks
      ? { reason: delegateDetection.reason, rawBody: delegateDetection.rawBody ?? '' }
      : null;

  let stripped = text;
  // Strip both successful *and* malformed coordination blocks so the raw
  // JSON never leaks into the prose — the malformed signal is surfaced as
  // a failed HandoffCard / DelegateCard instead, giving the user real
  // feedback instead of a wall of broken JSON. Stripping malformed
  // delegate blocks is the fix for the "delegate doesn't show up" bug
  // where a bad block silently leaked into the message and the side panel
  // never populated.
  if (handoff || handoffMalformed) stripped = stripped.replace(HANDOFF_RE, '').trimEnd();
  if (delegate || delegateMalformed) stripped = stripped.replace(DELEGATE_RE, '').trimEnd();

  // Collapse runs of 3+ blank lines that the strip can leave behind.
  stripped = stripped.replace(/\n{3,}/g, '\n\n').trim();

  return { stripped, handoff, delegate, handoffMalformed, delegateMalformed };
}
