/** An open `/skill` query: the `/` at `start`, the filter typed after it, ending at `end`. */
export interface SlashQuery {
  start: number;
  end: number;
  query: string;
}

/**
 * The slash command being typed at `caret` in `text`, or null. A command
 * starts a line: `/` at the very start or right after a newline.
 */
export function findSlashQuery(text: string, caret: number): SlashQuery | null {
  if (caret < 0 || caret > text.length) return null;
  const match = text.slice(0, caret).match(/(^|\n)\/([a-zA-Z0-9_.-]*)$/);
  if (!match) return null;
  const start = caret - match[0].length + match[1].length;
  return { start, end: caret, query: match[2] };
}

/** `text` with the query replaced by `/<skillId> `, and the caret after it. */
export function insertSlashCommand(
  text: string,
  slash: SlashQuery,
  skillId: string,
): { text: string; caret: number } {
  const before = `${text.slice(0, slash.start)}/${skillId} `;
  return { text: before + text.slice(slash.end), caret: before.length };
}
