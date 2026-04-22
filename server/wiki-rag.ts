import { searchWiki, type SearchResultRow } from './wiki-embeddings.js';

const MAX_QUERY_CHARS = 600;
const MAX_RESULTS = 4;
const MAX_EXCERPT_CHARS = 420;
const MAX_TOTAL_BLOCK_CHARS = 3200;
/** Hybrid wiki search costs an embedding call — only use on eligible first turns. */
const MIN_QUERY_CHARS_FOR_FIRST_TURN_RAG = 12;

function cleanText(input: string): string {
  return input
    .replace(/<mark>/gi, '')
    .replace(/<\/mark>/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function clip(input: string, max: number): string {
  if (input.length <= max) return input;
  return `${input.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

function toExcerpt(row: SearchResultRow): string {
  const source = cleanText(row.matchedChunk || row.snippet || '');
  if (!source) return '(no excerpt available)';
  return clip(source, MAX_EXCERPT_CHARS);
}

export function normalizeRagQuery(raw: string): string {
  return clip(cleanText(raw || ''), MAX_QUERY_CHARS);
}

export function formatWikiRagContext(query: string, rows: SearchResultRow[]): string {
  if (!rows.length) return '';

  const header =
    `## Retrieved Wiki Context\n` +
    `Query: "${query}"\n` +
    `Use this as supporting project context. If it conflicts with newer user instructions, follow the user.\n`;

  const body = rows
    .slice(0, MAX_RESULTS)
    .map((r, idx) => {
      const score = Number.isFinite(r.score) ? r.score.toFixed(3) : 'n/a';
      return (
        `${idx + 1}. ${r.title} (${r.category}) — slug: ${r.slug}, score: ${score}\n` +
        `   Excerpt: ${toExcerpt(r)}`
      );
    })
    .join('\n');

  return clip(`${header}${body}`, MAX_TOTAL_BLOCK_CHARS);
}

/**
 * Build a compact RAG context block from wiki hybrid retrieval.
 * Returns '' when there is no useful query or no results.
 */
export async function buildWikiRagContext(projectId: string, userMessage: string): Promise<string> {
  const query = normalizeRagQuery(userMessage);
  if (!projectId || !query) return '';

  const rows = await searchWiki(projectId, query, {
    mode: 'hybrid',
    limit: MAX_RESULTS,
  });
  return formatWikiRagContext(query, rows);
}

/**
 * Whether to run hybrid wiki retrieval for this turn. Limits embedding/API use
 * to at most one hybrid pass per session (see `wiki_hybrid_rag_consumed`), and
 * skips slash-skill turns.
 */
export function shouldAttachWikiRag(input: {
  /** False once this session has completed a hybrid wiki retrieval (or no budget left). */
  hybridRagNotYetConsumed: boolean;
  userMessage: string;
  slashSkillActive: boolean;
}): boolean {
  if (!input.hybridRagNotYetConsumed || input.slashSkillActive) return false;
  const q = normalizeRagQuery(input.userMessage);
  return q.length >= MIN_QUERY_CHARS_FOR_FIRST_TURN_RAG;
}

export interface WikiHybridRagUserTurnResult {
  /** Suffix to append to the system prompt (empty when skipped or no block). */
  promptSuffix: string;
  /**
   * When true, persist `wiki_hybrid_rag_consumed = 1` for the session. Set
   * after `buildWikiRagContext` resolves (including empty result). Not set on
   * throw so a later turn can retry after transient failures.
   */
  shouldMarkWikiHybridRagConsumed: boolean;
  /** Non-null when retrieval threw; caller should log. */
  logWarning: string | null;
}

/**
 * Single entry point for the chat handler: eligibility, `buildWikiRagContext`,
 * and consumption semantics. Covered by `wiki-rag.test.ts` so `chat.ts` can
 * stay a thin callsite.
 */
export async function runWikiHybridRagForUserTurn(
  projectId: string,
  userMessage: string,
  options: {
    wikiHybridRagConsumed: number | null | undefined;
    slashSkillActive: boolean;
  },
): Promise<WikiHybridRagUserTurnResult> {
  const hybridRagNotYetConsumed = !options.wikiHybridRagConsumed;
  if (
    !shouldAttachWikiRag({
      hybridRagNotYetConsumed,
      userMessage,
      slashSkillActive: options.slashSkillActive,
    })
  ) {
    return { promptSuffix: '', shouldMarkWikiHybridRagConsumed: false, logWarning: null };
  }
  try {
    const ragContext = await buildWikiRagContext(projectId, userMessage);
    return {
      promptSuffix: ragContext ? `\n\n${ragContext}` : '',
      shouldMarkWikiHybridRagConsumed: true,
      logWarning: null,
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { promptSuffix: '', shouldMarkWikiHybridRagConsumed: false, logWarning: message };
  }
}
