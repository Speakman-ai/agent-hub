import { searchWiki, type SearchResultRow } from './wiki-embeddings.js';
import { MAX_AGENTHUB_CONTROL_BLOCK_JSON_BYTES } from './agenthub-control-limits.js';
import { stripFencedCodeBlockBodies } from './action-block-parsing.js';

const MAX_QUERY_CHARS = 600;
const MAX_RESULTS = 6;
const MAX_EXCERPT_CHARS = 420;
const MAX_TOTAL_BLOCK_CHARS = 5000;
/** Hybrid wiki search costs an embedding call — only use on eligible turns with budget left. */
const MIN_QUERY_CHARS_FOR_FIRST_TURN_RAG = 12;
export const MAX_WIKI_RAG_CALLS_PER_SESSION = 16;

/**
 * Relevance floor for the automatic (backend) wiki-RAG path, expressed as raw
 * cosine similarity in `[-1, 1]` — NOT the min-max normalized `score`/`semanticScore`
 * a result row also carries. Normalization forces the top hit toward the high end
 * of every result set regardless of true quality, so a threshold on the displayed
 * score cannot tell a great match from the best of a bad batch. We gate on
 * `SearchResultRow.rawSemanticScore` instead. Pages below this bar are dropped from
 * the injected prompt block; if nothing clears it, the turn attaches nothing and
 * the UI shows a "wiki checked, no strong match" chip. Tunable; kept conservative
 * so genuinely relevant pages still pass. Only the automatic path applies this
 * floor — the agent-initiated `<agenthub:wiki>` path returns whatever matches, since
 * the agent explicitly chose the query.
 */
export const WIKI_RAG_MIN_COSINE = 0.6;

export { MAX_AGENTHUB_CONTROL_BLOCK_JSON_BYTES };

/**
 * Legacy sessions used `wiki_hybrid_rag_budget_version = 0` with `wiki_hybrid_rag_consumed`
 * as a 0/1 gate (1 = hybrid already ran, no more). New sessions use `budget_version = 1` and
 * a monotonic call counter. Map legacy "exhausted" to `maxCalls` so installs do not get
 * extra hybrid retrievals after upgrade.
 */
export function effectiveWikiHybridRagUsedCount(
  stored: number | null | undefined,
  budgetVersion: number | null | undefined,
  maxCalls: number,
): number {
  const raw = stored ?? 0;
  const ver = budgetVersion ?? 0;
  if (ver === 0) {
    return raw >= 1 ? maxCalls : 0;
  }
  return Math.min(Math.max(0, raw), maxCalls);
}

/** DB row after one successful hybrid retrieval increment. */
export function nextWikiHybridRagRowAfterIncrement(
  stored: number | null | undefined,
  budgetVersion: number | null | undefined,
  maxCalls: number,
): { consumed: number; budgetVersion: number } {
  const s = stored ?? 0;
  const bv = budgetVersion ?? 0;
  if (bv === 0 && s === 0) {
    return { consumed: 1, budgetVersion: 1 };
  }
  return { consumed: Math.min(s + 1, maxCalls), budgetVersion: 1 };
}

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

export interface AssistantWikiRequest {
  query: string;
}

export interface AssistantWikiRequestMalformed {
  error: 'malformed';
  detail: string;
}

export function detectWikiRequestBlock(text: string): string | null {
  if (typeof text !== 'string' || !text.trim()) return null;
  // Mask fenced code-block bodies so documentation examples that show
  // `<agenthub:wiki>...` syntax inside ``` / ~~~ aren't parsed as
  // real wiki RAG invocations. See `detectSkillBlock` for the longer
  // rationale (auto-continuation feedback loop on quoted examples).
  const scanned = stripFencedCodeBlockBodies(text);
  const re = /<agenthub:wiki>\s*[\s\S]*?\s*<\/agenthub:wiki>/gi;
  let match: RegExpExecArray | null;
  let last: string | null = null;
  while ((match = re.exec(scanned)) !== null) {
    last = match[0];
  }
  return last;
}

export function parseWikiRequestBlock(
  raw: string,
): AssistantWikiRequest | AssistantWikiRequestMalformed {
  if (typeof raw !== 'string' || !raw.trim()) {
    return { error: 'malformed', detail: 'Empty wiki block payload' };
  }
  const tagMatch = raw.match(/<agenthub:wiki>\s*([\s\S]*?)\s*<\/agenthub:wiki>/i);
  const payload = (tagMatch ? tagMatch[1] : raw).trim();
  if (Buffer.byteLength(payload, 'utf-8') > MAX_AGENTHUB_CONTROL_BLOCK_JSON_BYTES) {
    return {
      error: 'malformed',
      detail: `Wiki block JSON exceeds ${MAX_AGENTHUB_CONTROL_BLOCK_JSON_BYTES} byte cap`,
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch (err) {
    return { error: 'malformed', detail: `Invalid JSON: ${(err as Error).message}` };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { error: 'malformed', detail: 'Wiki block payload must be a JSON object' };
  }
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.query !== 'string') {
    return { error: 'malformed', detail: 'Missing required string field: query' };
  }
  const query = normalizeRagQuery(obj.query);
  if (!query) {
    return { error: 'malformed', detail: 'Field "query" cannot be empty' };
  }
  return { query };
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

  return buildWikiRagContextFromQuery(projectId, query);
}

export async function buildWikiRagContextFromQuery(
  projectId: string,
  query: string,
): Promise<string> {
  if (!projectId || !query) return '';
  const rows = await retrieveWikiRows(projectId, query);
  return formatWikiRagContext(query, rows);
}

/** Raw hybrid retrieval (no relevance floor). Shared by the block builder and the user-turn path. */
export async function retrieveWikiRows(
  projectId: string,
  query: string,
): Promise<SearchResultRow[]> {
  if (!projectId || !query) return [];
  return searchWiki(projectId, query, { mode: 'hybrid', limit: MAX_RESULTS });
}

/**
 * Drop rows whose raw cosine similarity is below `minCosine`. When no row carries
 * a raw cosine (e.g. Gemini not configured, so hybrid degraded to FTS-only), the
 * floor is not applicable and all rows are preserved — suppressing the FTS
 * fallback entirely would be a silent regression for keyless installs.
 */
export function applyRelevanceFloor(
  rows: SearchResultRow[],
  minCosine: number = WIKI_RAG_MIN_COSINE,
): SearchResultRow[] {
  const hasCosine = rows.some((r) => typeof r.rawSemanticScore === 'number');
  if (!hasCosine) return rows;
  return rows.filter(
    (r) => typeof r.rawSemanticScore === 'number' && r.rawSemanticScore >= minCosine,
  );
}

/**
 * Whether to run hybrid wiki retrieval for this turn. Limits embedding/API use
 * to a bounded number of passes per session (see `wiki_hybrid_rag_consumed`), and
 * skips slash-skill turns.
 */
export function shouldAttachWikiRag(input: {
  /** Number of completed hybrid retrieval calls in this session. */
  wikiHybridRagUsedCount: number;
  /** Maximum hybrid retrieval calls allowed for this session. */
  maxCallsPerSession?: number;
  userMessage: string;
  slashSkillActive: boolean;
}): boolean {
  const used = Number.isFinite(input.wikiHybridRagUsedCount) ? input.wikiHybridRagUsedCount : 0;
  const maxCalls =
    input.maxCallsPerSession && input.maxCallsPerSession > 0
      ? input.maxCallsPerSession
      : MAX_WIKI_RAG_CALLS_PER_SESSION;
  if (used >= maxCalls || input.slashSkillActive) return false;
  const q = normalizeRagQuery(input.userMessage);
  return q.length >= MIN_QUERY_CHARS_FOR_FIRST_TURN_RAG;
}

/** One page shown in the persisted "Consulted wiki" chip. */
export interface WikiRagIndicatorPage {
  title: string;
  slug: string;
  category: string;
  /** Min-max normalized blended score (as shown in the injected block). */
  score: number;
  /** Raw cosine similarity of the best chunk, when available (pre-normalization). */
  rawScore?: number;
}

/**
 * User-visible record that the automatic wiki-RAG path ran on a turn. Persisted
 * on the assistant message row (`metadata.wikiRag`) and rendered as a chip in
 * web + mobile. `status: 'consulted'` means pages cleared the relevance floor and
 * were injected into the prompt; `status: 'no_match'` means retrieval ran but
 * nothing cleared the floor (or there were no results), so nothing was injected.
 */
export interface WikiRagIndicator {
  status: 'consulted' | 'no_match';
  /** Number of pages injected into the prompt (0 when `no_match`). */
  retrieved: number;
  /** Pages injected, best-first (empty when `no_match`). */
  pages: WikiRagIndicatorPage[];
  /** Query used for retrieval (the user's message, normalized). */
  query: string;
}

export interface WikiHybridRagUserTurnResult {
  /** Suffix to append to the system prompt (empty when skipped or no block). */
  promptSuffix: string;
  /**
   * When true, increment `wiki_hybrid_rag_consumed` for the session. Set once
   * retrieval actually ran (including a `no_match` result — the embedding call
   * was still spent). Not set on throw or when retrieval was skipped, so a later
   * turn can retry after transient failures.
   */
  shouldIncrementWikiHybridRagUsage: boolean;
  /** Non-null when retrieval threw; caller should log. */
  logWarning: string | null;
  /**
   * Non-null when retrieval actually ran (eligible + no throw); drives the
   * persisted "Consulted wiki" chip. Null when retrieval was skipped (ineligible,
   * budget exhausted, slash-skill turn) or threw — no chip in those cases.
   */
  indicator: WikiRagIndicator | null;
}

function toIndicatorPage(r: SearchResultRow): WikiRagIndicatorPage {
  return {
    title: r.title,
    slug: r.slug,
    category: r.category,
    score: Number.isFinite(r.score) ? r.score : 0,
    ...(typeof r.rawSemanticScore === 'number' ? { rawScore: r.rawSemanticScore } : {}),
  };
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
    wikiHybridRagUsedCount: number | null | undefined;
    maxCallsPerSession?: number;
    slashSkillActive: boolean;
  },
): Promise<WikiHybridRagUserTurnResult> {
  if (
    !shouldAttachWikiRag({
      wikiHybridRagUsedCount: options.wikiHybridRagUsedCount ?? 0,
      maxCallsPerSession: options.maxCallsPerSession,
      userMessage,
      slashSkillActive: options.slashSkillActive,
    })
  ) {
    return {
      promptSuffix: '',
      shouldIncrementWikiHybridRagUsage: false,
      logWarning: null,
      indicator: null,
    };
  }
  const query = normalizeRagQuery(userMessage);
  try {
    const rows = await retrieveWikiRows(projectId, query);
    const kept = applyRelevanceFloor(rows);
    if (kept.length > 0) {
      const block = formatWikiRagContext(query, kept);
      return {
        promptSuffix: block ? `\n\n${block}` : '',
        shouldIncrementWikiHybridRagUsage: true,
        logWarning: null,
        indicator: {
          status: 'consulted',
          retrieved: kept.length,
          pages: kept.slice(0, MAX_RESULTS).map(toIndicatorPage),
          query,
        },
      };
    }
    // Retrieval ran but nothing cleared the relevance floor: inject nothing, but
    // surface a subtle "wiki checked, no strong match" chip. The embedding call
    // was spent, so still count it against the session budget.
    return {
      promptSuffix: '',
      shouldIncrementWikiHybridRagUsage: true,
      logWarning: null,
      indicator: { status: 'no_match', retrieved: 0, pages: [], query },
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      promptSuffix: '',
      shouldIncrementWikiHybridRagUsage: false,
      logWarning: message,
      indicator: null,
    };
  }
}

export interface WikiHybridRagAssistantResult {
  promptSuffix: string;
  shouldIncrementWikiHybridRagUsage: boolean;
  logWarning: string | null;
  errorSuffix: string;
}

export async function runWikiHybridRagForAssistantRequest(
  projectId: string,
  rawBlock: string,
  options: {
    wikiHybridRagUsedCount: number | null | undefined;
    maxCallsPerSession?: number;
  },
): Promise<WikiHybridRagAssistantResult> {
  const parsed = parseWikiRequestBlock(rawBlock);
  if ('error' in parsed) {
    return {
      promptSuffix: '',
      shouldIncrementWikiHybridRagUsage: false,
      logWarning: null,
      errorSuffix: `## Wiki Load Error\nMalformed <agenthub:wiki> block: ${parsed.detail}`,
    };
  }
  const used = options.wikiHybridRagUsedCount ?? 0;
  const maxCalls =
    options.maxCallsPerSession && options.maxCallsPerSession > 0
      ? options.maxCallsPerSession
      : MAX_WIKI_RAG_CALLS_PER_SESSION;
  if (used >= maxCalls) {
    return {
      promptSuffix: '',
      shouldIncrementWikiHybridRagUsage: false,
      logWarning: null,
      errorSuffix: `## Wiki Load Error\nSession wiki retrieval budget exhausted (${used}/${maxCalls}).`,
    };
  }
  try {
    const ragContext = await buildWikiRagContextFromQuery(projectId, parsed.query);
    return {
      promptSuffix: ragContext ? `\n\n${ragContext}` : '',
      shouldIncrementWikiHybridRagUsage: true,
      logWarning: null,
      errorSuffix: '',
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      promptSuffix: '',
      shouldIncrementWikiHybridRagUsage: false,
      logWarning: message,
      errorSuffix: '## Wiki Load Error\nFailed to retrieve wiki context for this request.',
    };
  }
}
