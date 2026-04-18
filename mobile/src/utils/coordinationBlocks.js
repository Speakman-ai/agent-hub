/**
 * Mobile twin of `client/src/utils/coordinationBlocks.js`.
 *
 * Parses `<handoff>` and `<delegate>` blocks out of an assistant message so
 * the chat can render a compact visual card instead of the raw JSON wall
 * the server stores on the message body.
 *
 * Kept dependency-free and identical in shape to the web util so behaviour
 * stays in sync. See the web file for the long-form rationale.
 */

const HANDOFF_RE = /<handoff>\s*([\s\S]*?)\s*<\/handoff>/;
const DELEGATE_RE = /<delegate>\s*([\s\S]*?)\s*<\/delegate>/;

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
    // Canonical field is `agentId` (matches server/delegation.ts). Accept
    // `toAgent` as a tolerant alias so mis-schooled / legacy messages still
    // strip cleanly in the UI.
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

export function extractCoordinationBlocks(text) {
  if (typeof text !== 'string' || text.length === 0) {
    return { stripped: text ?? '', handoff: null, delegate: null };
  }
  const handoff = parseHandoffBlock(text);
  const delegate = parseDelegateBlock(text);
  let stripped = text;
  if (handoff) stripped = stripped.replace(HANDOFF_RE, '').trimEnd();
  if (delegate) stripped = stripped.replace(DELEGATE_RE, '').trimEnd();
  stripped = stripped.replace(/\n{3,}/g, '\n\n').trim();
  return { stripped, handoff, delegate };
}

/**
 * Correlate a parsed `<handoff>` block back to a DB row from
 * `api.getSessionHandoffs(sessionId)`. The server's fuzzy resolver may
 * rewrite the raw `toAgent` (e.g. "agent-hub-backend" → "hub-backend"), so
 * we accept either the raw block id or the resolved `to_agent_id`,
 * preferring delivered rows and then the most recent match. When there is a
 * single row for the whole source session (common — handoff is terminal) we
 * return it unconditionally so pending/failed status still renders. Mirror
 * of `pickHandoffRow` in `client/src/components/SessionTail.jsx`.
 */
export function pickHandoffRow(block, rows) {
  if (!Array.isArray(rows) || rows.length === 0) return null;
  const wanted = (block?.toAgent || '').trim().toLowerCase();
  const match = (r) => {
    const rowAgent = (r?.to_agent_id || '').toLowerCase();
    if (!wanted || !rowAgent) return false;
    return (
      rowAgent === wanted ||
      rowAgent.endsWith(`-${wanted}`) ||
      wanted.endsWith(`-${rowAgent}`) ||
      wanted.includes(rowAgent) ||
      rowAgent.includes(wanted)
    );
  };
  return (
    rows.find((r) => r.status === 'delivered' && match(r)) ||
    rows.find((r) => match(r)) ||
    (rows.length === 1 ? rows[0] : null)
  );
}
