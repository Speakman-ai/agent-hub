/**
 * Code-RAG prompt augmentation — the chat-side glue for `code-embeddings.ts`.
 *
 * Mirrors `wiki-rag.ts`: a single entry point (`runCodeRagForUserTurn`) the chat
 * handler can call to (a) decide whether this turn is eligible, (b) hybrid-search
 * the indexed project code, and (c) format a compact, budget-capped context
 * block to append to the system prompt. Retrieval costs one embedding call, so
 * usage is bounded per session via `code_rag_consumed`.
 *
 * Unlike wiki RAG there is no legacy budget-version to migrate — code RAG is new,
 * so a plain monotonic counter is enough.
 */
import { searchCode, countProjectCodeChunks, type CodeSearchResult } from './code-embeddings.js';

const MAX_QUERY_CHARS = 600;
export const MAX_CODE_RESULTS = 6;
const MAX_EXCERPT_LINES = 18;
const MAX_EXCERPT_CHARS = 700;
const MAX_TOTAL_BLOCK_CHARS = 6000;
const MIN_QUERY_CHARS_FOR_CODE_RAG = 12;
export const MAX_CODE_RAG_CALLS_PER_SESSION = 10;

function cleanQuery(input: string): string {
  return (input || '').replace(/\s+/g, ' ').trim();
}

function clip(input: string, max: number): string {
  if (input.length <= max) return input;
  return `${input.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

export function normalizeCodeRagQuery(raw: string): string {
  return clip(cleanQuery(raw || ''), MAX_QUERY_CHARS);
}

function toExcerpt(text: string): string {
  const lines = (text || '').split('\n');
  const head = lines.slice(0, MAX_EXCERPT_LINES).join('\n');
  return clip(head, MAX_EXCERPT_CHARS);
}

export function formatCodeRagContext(query: string, rows: CodeSearchResult[]): string {
  if (!rows.length) return '';

  const header =
    `## Retrieved Project Code\n` +
    `Query: "${query}"\n` +
    `Top matches from the indexed project source. Citations are \`path:startLine-endLine\`. ` +
    `Treat as a retrieval hint — open the real file before relying on it; if it conflicts with newer instructions, follow the user.\n`;

  const body = rows
    .slice(0, MAX_CODE_RESULTS)
    .map((r, idx) => {
      const score = Number.isFinite(r.score) ? r.score.toFixed(3) : 'n/a';
      const cite = `${r.filePath}:${r.startLine}-${r.endLine}`;
      return `${idx + 1}. ${cite} (score: ${score})\n\`\`\`\n${toExcerpt(r.text)}\n\`\`\``;
    })
    .join('\n\n');

  return clip(`${header}\n${body}`, MAX_TOTAL_BLOCK_CHARS);
}

export async function buildCodeRagContext(projectId: string, userMessage: string): Promise<string> {
  const query = normalizeCodeRagQuery(userMessage);
  if (!projectId || !query) return '';
  const rows = await searchCode(projectId, query, { mode: 'hybrid', limit: MAX_CODE_RESULTS });
  return formatCodeRagContext(query, rows);
}

/**
 * Whether to run code retrieval for this turn. Requires a long-enough query,
 * remaining session budget, a non-slash turn, and — crucially — that the project
 * actually has indexed code (so we never spend an embedding call on a project
 * nobody has indexed). The chunk-count probe is a cheap COUNT(*).
 */
export function shouldAttachCodeRag(input: {
  codeRagUsedCount: number;
  maxCallsPerSession?: number;
  userMessage: string;
  slashSkillActive: boolean;
  projectId: string;
}): boolean {
  const used = Number.isFinite(input.codeRagUsedCount) ? input.codeRagUsedCount : 0;
  const maxCalls =
    input.maxCallsPerSession && input.maxCallsPerSession > 0
      ? input.maxCallsPerSession
      : MAX_CODE_RAG_CALLS_PER_SESSION;
  if (used >= maxCalls || input.slashSkillActive) return false;
  const q = normalizeCodeRagQuery(input.userMessage);
  if (q.length < MIN_QUERY_CHARS_FOR_CODE_RAG) return false;
  return countProjectCodeChunks(input.projectId) > 0;
}

export interface CodeRagUserTurnResult {
  /** Suffix to append to the system prompt (empty when skipped or no block). */
  promptSuffix: string;
  /** When true, increment `code_rag_consumed` for the session. */
  shouldIncrementCodeRagUsage: boolean;
  /** Non-null when retrieval threw; caller should log. */
  logWarning: string | null;
}

/**
 * Single entry point for the chat handler. Covered by `code-rag.test.ts` so
 * `chat.ts` stays a thin callsite.
 */
export async function runCodeRagForUserTurn(
  projectId: string,
  userMessage: string,
  options: {
    codeRagUsedCount: number | null | undefined;
    maxCallsPerSession?: number;
    slashSkillActive: boolean;
  },
): Promise<CodeRagUserTurnResult> {
  if (
    !shouldAttachCodeRag({
      codeRagUsedCount: options.codeRagUsedCount ?? 0,
      maxCallsPerSession: options.maxCallsPerSession,
      userMessage,
      slashSkillActive: options.slashSkillActive,
      projectId,
    })
  ) {
    return { promptSuffix: '', shouldIncrementCodeRagUsage: false, logWarning: null };
  }
  try {
    const ragContext = await buildCodeRagContext(projectId, userMessage);
    return {
      promptSuffix: ragContext ? `\n\n${ragContext}` : '',
      shouldIncrementCodeRagUsage: true,
      logWarning: null,
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { promptSuffix: '', shouldIncrementCodeRagUsage: false, logWarning: message };
  }
}
