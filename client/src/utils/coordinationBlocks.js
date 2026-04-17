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
 * Parse a `<handoff>` block out of `text`. Returns the parsed task or null
 * if the block is missing, malformed, or missing required fields. Matches
 * the validation in `server/handoff.ts#parseHandoffBlock`.
 */
export function parseHandoffBlock(text) {
  if (typeof text !== 'string' || !text.includes('<handoff>')) return null;
  const match = text.match(HANDOFF_RE);
  if (!match) return null;
  let parsed;
  try {
    parsed = JSON.parse(match[1]);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const toAgent = typeof parsed.toAgent === 'string' ? parsed.toAgent.trim() : '';
  const note = typeof parsed.note === 'string' ? parsed.note.trim() : '';
  if (!toAgent || !note) return null;
  return { toAgent, note };
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
    return { stripped: text ?? '', handoff: null, delegate: null };
  }

  const handoff = parseHandoffBlock(text);
  const delegate = parseDelegateBlock(text);

  let stripped = text;
  if (handoff) stripped = stripped.replace(HANDOFF_RE, '').trimEnd();
  if (delegate) stripped = stripped.replace(DELEGATE_RE, '').trimEnd();

  // Collapse runs of 3+ blank lines that the strip can leave behind.
  stripped = stripped.replace(/\n{3,}/g, '\n\n').trim();

  return { stripped, handoff, delegate };
}
