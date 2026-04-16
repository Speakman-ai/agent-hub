// Utilities for working with the `agenthub:ask:answer` fenced-block protocol
// on the client side. The server-side counterpart lives in server/stream-parser.ts.
//
// When a user submits an <AskUserQuestion> picker, the client sends a normal
// chat message whose body includes:
//
//   ```agenthub:ask:answer
//   { "askId": "ask-xyz", "answers": {...}, "annotations": {...} }
//   ```
//
// After a reload we need to know which pickers have already been answered so
// the UI renders them as disabled "Submitted". Rather than carrying a parallel
// React state that dies on refresh, we derive the set from message history by
// scanning user messages for answer blocks and pulling their askIds back out.

const ANSWER_FENCE_RE = /```agenthub:ask:answer\s*\n([\s\S]*?)\n?```/g;

/**
 * Extract every `askId` referenced by an `agenthub:ask:answer` block across a
 * list of messages. Returns a Set<string>.
 *
 * @param {Array<{role?: string, content?: string}>} messages
 * @returns {Set<string>}
 */
export function extractSubmittedAskIds(messages) {
  const out = new Set();
  if (!Array.isArray(messages)) return out;

  for (const msg of messages) {
    if (!msg || msg.role !== 'user') continue;
    const content = typeof msg.content === 'string' ? msg.content : null;
    if (!content || !content.includes('agenthub:ask:answer')) continue;

    // Fresh regex each call — /g state is reset.
    ANSWER_FENCE_RE.lastIndex = 0;
    let match;
    while ((match = ANSWER_FENCE_RE.exec(content)) !== null) {
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
