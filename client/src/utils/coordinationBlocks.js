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
 *   - parseHandoffBlock(text)   → { toAgent, note } | null
 *   - parseDelegateBlock(text)  → Array<{ agentId, task }> | null
 *   - extractCoordinationBlocks(text)
 *       → { stripped, handoff, delegate }
 *     so the rendered text can be the conversational prose alone, with the
 *     coordination intent shown as a dedicated card.
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
 * Parse a `<delegate>` block. Returns an array of `{agentId, task}` entries
 * (single-object blocks are coerced to a 1-element array) or null on missing
 * / malformed input. Mirrors `server/delegation.ts#parseDelegateBlock`.
 *
 * Field names: the canonical target field is `agentId`; we also accept
 * `toAgent` as a tolerant alias so messages authored before the schemas
 * were aligned still strip cleanly in the chat UI.
 */
export function parseDelegateBlock(text) {
  if (typeof text !== 'string' || !text.includes('<delegate>')) return null;
  const match = text.match(DELEGATE_RE);
  if (!match) return null;
  let parsed;
  try {
    parsed = JSON.parse(match[1]);
  } catch {
    return null;
  }
  const list = Array.isArray(parsed) ? parsed : [parsed];
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
  return tasks.length > 0 ? tasks : null;
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
    };
  }

  const detection = detectHandoffBlock(text);
  const handoff = detection.task;
  const handoffMalformed =
    detection.present && !detection.task
      ? { reason: detection.reason, rawBody: detection.rawBody ?? '' }
      : null;
  const delegate = parseDelegateBlock(text);

  let stripped = text;
  // Strip both successful *and* malformed handoff blocks so the raw JSON
  // never leaks into the prose — the malformed signal is surfaced as a
  // failed HandoffCard instead, giving the user real feedback instead of a
  // wall of broken JSON.
  if (handoff || handoffMalformed) stripped = stripped.replace(HANDOFF_RE, '').trimEnd();
  if (delegate) stripped = stripped.replace(DELEGATE_RE, '').trimEnd();

  // Collapse runs of 3+ blank lines that the strip can leave behind.
  stripped = stripped.replace(/\n{3,}/g, '\n\n').trim();

  return { stripped, handoff, delegate, handoffMalformed };
}
