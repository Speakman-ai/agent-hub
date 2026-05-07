/**
 * Client-side mirror of the server's `stripAssistantControlBlocks`.
 *
 * Removes agent-side action tags from rendered message text so they are
 * never surfaced as raw XML or fenced code blocks in the chat transcript.
 * The server already strips these from `messages.content` before DB
 * storage, but the same text also lives in `session_events` (as raw
 * `assistant_text` event payloads) which the client uses to build its
 * rendering blocks — those rows are intentionally immutable, so the
 * stripping must happen at render time on the client side.
 *
 * Tags removed (same set as the server):
 *   - <agenthub:react>
 *   - <agenthub:skill>
 *   - <agenthub:wiki>
 *   - <agenthub:task-state>
 *   - <agenthub:triage>
 *
 * A fenced code block whose ONLY content is one of these tags is also
 * removed (handles the "wrapped in backtick fences" variant that triggered
 * this bug in the first place).
 */
export function stripAssistantControlBlocks(text) {
  if (typeof text !== 'string' || !text) return text;

  const TAGS = [
    'agenthub:react',
    'agenthub:skill',
    'agenthub:wiki',
    'agenthub:task-state',
    'agenthub:triage',
  ];

  let result = text;

  for (const tag of TAGS) {
    // 1. Fenced code block first (BEFORE the naked-tag pass). If we strip the
    //    naked tag first, it removes the inner content but leaves the
    //    surrounding ``` lines as an empty code fence — which would then not
    //    match the fenced regex. Strip the whole fence block in one pass.
    //    We only strip a fence when its trimmed body is entirely the tag —
    //    this avoids clobbering legitimate code blocks that happen to mention
    //    these tags in documentation prose.
    const escapedTag = tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const fencedRe = new RegExp(
      `\`\`\`[^\`\\n]*\\n[ \\t]*<${escapedTag}>[\\s\\S]*?<\\/${escapedTag}>[ \\t]*\\n[ \\t]*\`\`\``,
      'gi',
    );
    result = result.replace(fencedRe, '');

    // 2. Naked XML tag (primary case — what agents should emit after the
    //    system-prompt instruction fix).
    const nakedRe = new RegExp(`<${escapedTag}>\\s*[\\s\\S]*?\\s*<\\/${escapedTag}>`, 'gi');
    result = result.replace(nakedRe, '');
  }

  // Collapse runs of 3+ blank lines down to 2 (one blank line in rendered
  // markdown), matching the server-side behaviour.
  result = result.replace(/\n{3,}/g, '\n\n').trim();

  return result;
}
