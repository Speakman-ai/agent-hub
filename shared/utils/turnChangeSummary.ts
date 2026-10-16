/**
 * Parse the `turn_change_summary` system-message metadata written by
 * `server/turn-change-summary.ts`.
 *
 * Like the Finalize timeline messages, the server writes metadata as
 * `JSON.stringify({ kind, ...payload })`, so every payload field sits at the TOP
 * level — read `parsed.<field>` directly, never `parsed.payload.<field>`.
 */

export const TURN_CHANGE_SUMMARY_KIND = 'turn_change_summary';

export interface TurnChangeSummaryMeta {
  summary: string;
  summarySource: 'llm' | 'none';
  manualTesting: string[];
  filesChanged: number | null;
  insertions: number | null;
  deletions: number | null;
}

function parseRaw(metadataString: unknown): Record<string, unknown> | null {
  if (metadataString == null) return null;
  try {
    const parsed = typeof metadataString === 'string' ? JSON.parse(metadataString) : metadataString;
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export function parseTurnChangeSummaryMetadata(
  metadataString: unknown,
): TurnChangeSummaryMeta | null {
  const parsed = parseRaw(metadataString);
  if (!parsed || parsed.kind !== TURN_CHANGE_SUMMARY_KIND) return null;
  return {
    summary: typeof parsed.summary === 'string' ? parsed.summary : '',
    summarySource: parsed.summarySource === 'llm' ? 'llm' : 'none',
    manualTesting: Array.isArray(parsed.manualTesting)
      ? parsed.manualTesting.filter((s: unknown): s is string => typeof s === 'string' && !!s)
      : [],
    filesChanged: typeof parsed.filesChanged === 'number' ? parsed.filesChanged : null,
    insertions: typeof parsed.insertions === 'number' ? parsed.insertions : null,
    deletions: typeof parsed.deletions === 'number' ? parsed.deletions : null,
  };
}
