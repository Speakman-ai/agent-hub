/**
 * Determine whether a session is waiting for user input.
 *
 * A session is "awaiting user input" when its most recent assistant message
 * contains one or more `agenthub:ask` pickers whose `askId` has not yet been
 * answered by a subsequent user `agenthub:ask:answer` block.
 *
 * Shared by:
 *   - server/awaiting-input.ts (canonical detection emitted over WebSocket)
 *   - tests on both sides
 *
 * The client-side sidebar consumes the server's broadcast directly rather than
 * recomputing this on every render. Keeping the logic in shared/ means the
 * server test fixtures and the client test fixtures stay in lockstep with one
 * implementation.
 */

import { extractAskBlocks } from './extractAskBlocks.js';

const ANSWER_FENCE_RE = /```agenthub:ask:answer\s*\n([\s\S]*?)\n?```/g;
const ANSWER_XML_RE = /<agenthub:ask:answer>\s*([\s\S]*?)\s*<\/agenthub:ask:answer>/gi;

/**
 * Pull every askId referenced by any `agenthub:ask:answer` block in a chat
 * message body. Returns a Set so callers can union across messages.
 *
 * @param {string} content
 * @returns {Set<string>}
 */
function collectAnsweredAskIds(content) {
  const out = new Set();
  if (typeof content !== 'string' || !content.includes('agenthub:ask:answer')) {
    return out;
  }
  for (const re of [ANSWER_FENCE_RE, ANSWER_XML_RE]) {
    re.lastIndex = 0;
    let match;
    while ((match = re.exec(content)) !== null) {
      const body = match[1]?.trim();
      if (!body) continue;
      try {
        const parsed = JSON.parse(body);
        const askId = parsed && typeof parsed.askId === 'string' ? parsed.askId : null;
        if (askId) out.add(askId);
      } catch {
        // Malformed answer block — skip.
      }
    }
  }
  return out;
}

/**
 * Given a session's full message history (sorted by created_at ASC, the same
 * order the DB returns), return the array of askIds that are still unanswered
 * in the most recent assistant message.
 *
 * Empty array means the session is NOT awaiting user input.
 *
 * @param {Array<{ role?: string, content?: string }>} messages
 * @returns {string[]}
 */
export function findUnansweredAskIds(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return [];

  // Find the most recent assistant message in the session.
  let latestAssistant = null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m && m.role === 'assistant') {
      latestAssistant = m;
      break;
    }
  }
  if (!latestAssistant || typeof latestAssistant.content !== 'string') return [];
  if (!latestAssistant.content.includes('agenthub:ask')) return [];

  const { asks } = extractAskBlocks(latestAssistant.content);
  if (!Array.isArray(asks) || asks.length === 0) return [];

  // Union of every askId answered by any user message in the session. We don't
  // restrict to "after the assistant message" because the protocol replays
  // historical answers verbatim, and an answer block earlier in the transcript
  // for a re-emitted askId still counts as submitted (matches the client-side
  // `extractSubmittedAskIds` behavior).
  const answered = new Set();
  for (const msg of messages) {
    if (!msg || msg.role !== 'user') continue;
    for (const id of collectAnsweredAskIds(msg.content || '')) {
      answered.add(id);
    }
  }

  const out = [];
  for (const ask of asks) {
    const askId = ask && typeof ask.askId === 'string' ? ask.askId : null;
    if (!askId) continue;
    if (!answered.has(askId)) out.push(askId);
  }
  return out;
}
