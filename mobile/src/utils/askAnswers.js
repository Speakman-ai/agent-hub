// Utilities for working with the `agenthub:ask:answer` fenced-block protocol
// on the mobile client. Mirrors `client/src/utils/askAnswers.js`.
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

// Matches an `agenthub:ask:answer` fenced block along with the optional
// "Here are my answers:" prose prefix that <AskUserQuestion> prepends when it
// submits. Used to strip the raw JSON from the chat transcript — the picker
// UI itself already provides the visual "Submitted" confirmation, so showing
// the payload again in the message thread is pure noise.
const ANSWER_FENCE_WITH_PREFIX_RE =
  /(?:Here are my answers:\s*\n+)?```agenthub:ask:answer\s*\n[\s\S]*?\n?```/g;

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

/**
 * Strip any `agenthub:ask:answer` fenced blocks (and their optional
 * "Here are my answers:" prose prefix) from a chat message's content.
 *
 * The picker UI in <AskUserQuestion> already shows "Answers submitted" once
 * the user submits, so rendering the raw JSON payload as a separate user
 * bubble in the transcript is redundant noise. The block is preserved in the
 * persisted message content (the assistant/LLM still receives it as context),
 * but hidden from the visible transcript.
 *
 * Returns the cleaned content, with surrounding whitespace trimmed. Non-string
 * inputs are returned as-is.
 *
 * @param {string} content
 * @returns {string}
 */
export function stripAskAnswerBlocks(content) {
  if (typeof content !== 'string') return content;
  if (!content.includes('agenthub:ask:answer')) return content;
  return content.replace(ANSWER_FENCE_WITH_PREFIX_RE, '').trim();
}
