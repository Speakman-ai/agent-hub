/**
 * Shared client + server helper: remove Agent Hub control-block tags (and
 * “documentation-example” fenced wrappers) from assistant-visible prose.
 *
 * Kept in `shared/` so web, mobile, Electron, and the Node server cannot drift.
 */

const TAGS = [
  'agenthub:react',
  'agenthub:skill',
  'agenthub:wiki',
  'agenthub:task-state',
  'agenthub:triage',
];

/**
 * @param {string | null | undefined} text
 * @returns {string | null | undefined}
 */
export function stripAssistantControlBlocks(text) {
  if (text == null) return text;
  if (typeof text !== 'string' || !text) return text;

  let result = text;
  for (const tag of TAGS) {
    const escapedTag = tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

    // Triple-backtick fences (language line optional). Tolerate \r\n.
    result = result.replace(
      new RegExp(
        '```[^`\\n]*\\r?\\n[ \\t]*<' +
          escapedTag +
          '>[\\s\\S]*?</' +
          escapedTag +
          '>[ \\t]*\\r?\\n[ \\t]*```',
        'gi',
      ),
      '',
    );

    // Triple-tilde fences (same semantics as ``` for agents that copy wiki examples).
    result = result.replace(
      new RegExp(
        '~~~[^~\\n]*\\r?\\n[ \\t]*<' +
          escapedTag +
          '>[\\s\\S]*?</' +
          escapedTag +
          '>[ \\t]*\\r?\\n[ \\t]*~~~',
        'gi',
      ),
      '',
    );

    result = result.replace(
      new RegExp(`<${escapedTag}>\\s*[\\s\\S]*?\\s*</${escapedTag}>`, 'gi'),
      '',
    );
  }

  result = result.replace(/\n{3,}/g, '\n\n').trim();
  return result;
}
