function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Regex source for a control tag's opening tag, e.g. `<agenthub:react>`.
 * The opening tag is always required in full `agenthub:`-prefixed form —
 * this is what anchors the match, so it must not be loosened.
 */
export function openTagPatternSource(tagName: string): string {
  return `<${escapeRegExp(tagName)}>`;
}

/**
 * Regex source for a control tag's closing tag, tolerant of a prefix-less
 * close. Models occasionally drop the `agenthub:` prefix on the CLOSING tag
 * only, emitting `<agenthub:react>{...}</react>`. When the closer doesn't
 * match, the block is neither executed (the ReAct auto-continuation never
 * fires and the turn silently ends) nor stripped (it leaks into the rendered
 * markdown, where react-markdown autolinks it into garbled visible text).
 *
 * The full-form opening tag is still required by callers, so a bare `</react>`
 * with no matching `<agenthub:react>` open can never be matched here.
 *
 * For `agenthub:react` this yields `</(?:agenthub:)?react>`.
 */
export function closeTagPatternSource(tagName: string): string {
  const colon = tagName.indexOf(':');
  if (colon === -1) return `</${escapeRegExp(tagName)}>`;
  const prefix = tagName.slice(0, colon);
  const local = tagName.slice(colon + 1);
  return `</(?:${escapeRegExp(prefix)}:)?${escapeRegExp(local)}>`;
}
