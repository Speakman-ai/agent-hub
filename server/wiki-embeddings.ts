/**
 * Wiki semantic search — embedding pipeline + hybrid ranker.
 *
 * - Chunker splits markdown into overlapping ~char-sized chunks (char count is a
 *   close-enough proxy for tokens at our scale; ~4 chars per token).
 * - `embedTexts` calls Gemini's `gemini-embedding-001` REST endpoint (or whichever
 *   model is configured via `GEMINI_EMBED_MODEL`). Swappable via
 *   `setEmbedClient` so tests don't hit the network.
 *   NOTE: the legacy `text-embedding-004` model was shut down on 2026-01-14
 *   (https://ai.google.dev/gemini-api/docs/deprecations) and started
 *   returning 404 NOT_FOUND on `v1beta`. `gemini-embedding-001` is the
 *   current text-only embedding model on `v1beta:batchEmbedContents`. The
 *   embedding spaces are not compatible across model families — any rows
 *   persisted under the old model name are stale (different dim) and are
 *   excluded in SQL (`WHERE model = ?`) so they are never loaded or decoded
 *   on the retrieval hot path. Operators should re-run the backfill endpoint
 *   after deploying.
 * - `rankHybrid` blends normalized FTS5 BM25 with cosine similarity (50/50 by
 *   default). Input is a list of FTS hits + a list of embedding rows for the
 *   project; output is a sorted list of (page, score, chunk) triples.
 *
 * BLOB format: raw Float32Array bytes (embedding.length * 4 bytes). Little-endian
 * by host convention — we always encode/decode with the same helper so it
 * doesn't matter as long as the db isn't moved to a different-endian machine,
 * which is not a realistic concern.
 */
import { db, stmts } from './db.js';
import type Database from 'better-sqlite3';
import type { Stmts, WikiPageRow } from './types.js';
import config from './config.js';

// ─── Types ──────────────────────────────────────────────────────────

export interface EmbeddingVector {
  values: number[];
}

export interface EmbedClient {
  embedTexts(texts: string[], taskType?: EmbedTaskType): Promise<EmbeddingVector[]>;
}

export type EmbedTaskType = 'RETRIEVAL_DOCUMENT' | 'RETRIEVAL_QUERY' | 'SEMANTIC_SIMILARITY';

export interface Chunk {
  idx: number;
  text: string;
}

export interface EmbeddingRow {
  page_id: string;
  chunk_idx: number;
  chunk_text: string;
  embedding: Buffer;
  model: string;
}

export interface SearchResultRow {
  id: string;
  project_id: string;
  title: string;
  slug: string;
  category: string;
  updated_by: string;
  created_at: string;
  updated_at: string;
  score: number;
  ftsScore?: number;
  semanticScore?: number;
  /**
   * Raw cosine similarity of the best-matching chunk, in `[-1, 1]`, BEFORE the
   * min-max normalization that `semanticScore` carries. This is an absolute
   * measure of semantic relevance suitable for a fixed threshold (a relevance
   * floor); `semanticScore`/`score` are normalized per-result-set and so cannot
   * be compared against a constant. Undefined when the page had no semantic hit
   * (FTS-only) or on the FTS fallback path.
   */
  rawSemanticScore?: number;
  matchedChunk?: string;
  snippet?: string;
}

export type SearchMode = 'hybrid' | 'semantic' | 'fts';

// ─── Chunker ────────────────────────────────────────────────────────

const DEFAULT_CHUNK_CHARS = 3000; // ~750 tokens
const DEFAULT_OVERLAP_CHARS = 400; // ~100 tokens

/**
 * Split a markdown blob into overlapping chunks. Prefers paragraph boundaries
 * when the running buffer exceeds `maxChars`; falls back to hard-slicing if a
 * single paragraph is larger than the target. `overlap` chars of the tail are
 * carried into the next chunk so retrieval at the seam isn't penalized.
 */
export function chunkMarkdown(
  content: string,
  maxChars: number = DEFAULT_CHUNK_CHARS,
  overlap: number = DEFAULT_OVERLAP_CHARS,
): Chunk[] {
  const normalized = (content || '').trim();
  if (!normalized) return [];

  const chunks: Chunk[] = [];
  let buffer = '';
  const paragraphs = normalized.split(/\n{2,}/);

  const flush = (): void => {
    const text = buffer.trim();
    if (!text) return;
    chunks.push({ idx: chunks.length, text });
    // Seed the next buffer with the tail overlap so continuity is preserved.
    buffer = overlap > 0 && text.length > overlap ? text.slice(-overlap) + '\n\n' : '';
  };

  for (const para of paragraphs) {
    // If the paragraph alone exceeds maxChars, flush what we have and hard-slice.
    if (para.length > maxChars) {
      if (buffer.trim()) flush();
      let offset = 0;
      while (offset < para.length) {
        const slice = para.slice(offset, offset + maxChars);
        chunks.push({ idx: chunks.length, text: slice.trim() });
        offset += maxChars - overlap;
        if (maxChars - overlap <= 0) break; // safety
      }
      continue;
    }

    if (buffer.length + para.length + 2 > maxChars) {
      flush();
    }
    buffer += (buffer ? '\n\n' : '') + para;
  }
  if (buffer.trim()) flush();

  return chunks;
}

// ─── BLOB encoding ──────────────────────────────────────────────────

export function encodeEmbedding(values: number[]): Buffer {
  const arr = new Float32Array(values);
  return Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength);
}

export function decodeEmbedding(blob: Buffer): Float32Array {
  // Buffer may be a view into a larger ArrayBuffer — copy to be safe.
  const ab = blob.buffer.slice(blob.byteOffset, blob.byteOffset + blob.byteLength);
  return new Float32Array(ab);
}

// ─── Cosine similarity ─────────────────────────────────────────────

export function cosineSimilarity(a: ArrayLike<number>, b: ArrayLike<number>): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!;
    const y = b[i]!;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

// ─── Gemini REST client ────────────────────────────────────────────

// Gemini's `text-embedding-004` was deprecated and shut down on 2026-01-14
// (https://ai.google.dev/gemini-api/docs/deprecations). Default to its
// recommended replacement, `gemini-embedding-001`, which uses the same
// `embedContent` / `batchEmbedContents` shape on the `v1beta` endpoint but
// returns vectors of a different dimensionality, so existing stored
// embeddings under the old model name are NOT compatible and should be
// re-generated via the backfill endpoint. `GEMINI_EMBED_MODEL` env override
// is preserved for staging/testing alternative models.
export const DEFAULT_MODEL = process.env.GEMINI_EMBED_MODEL || 'gemini-embedding-001';

class MissingGeminiKeyError extends Error {
  constructor() {
    super(
      'GEMINI_API_KEY is not set and config.geminiApiKey is empty — wiki embeddings require a Gemini API key.',
    );
    this.name = 'MissingGeminiKeyError';
  }
}

function resolveApiKey(): string {
  const key =
    (config as { geminiApiKey?: string | null }).geminiApiKey || process.env.GEMINI_API_KEY || '';
  if (!key) throw new MissingGeminiKeyError();
  return key;
}

/**
 * Default network-backed client. Uses `batchEmbedContents` to embed up to ~100
 * texts per request (Gemini's default per-call cap is generous for our scale).
 * Callers must have an API key configured — otherwise we throw
 * `MissingGeminiKeyError` which embedPage / backfill handles as a "skip".
 */
export const defaultEmbedClient: EmbedClient = {
  async embedTexts(texts: string[], taskType: EmbedTaskType = 'RETRIEVAL_DOCUMENT') {
    if (texts.length === 0) return [];
    const apiKey = resolveApiKey();
    const model = DEFAULT_MODEL;
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:batchEmbedContents`;

    const body = {
      requests: texts.map((text) => ({
        model: `models/${model}`,
        content: { parts: [{ text }] },
        taskType,
      })),
    };

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'x-goog-api-key': apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Gemini embed failed (${res.status}): ${text.slice(0, 500)}`);
    }

    const parsed = (await res.json()) as {
      embeddings?: { values?: number[]; value?: number[] }[];
    };
    const embs = parsed.embeddings ?? [];
    return embs.map((e) => ({ values: e.values ?? e.value ?? [] }));
  },
};

let activeEmbedClient: EmbedClient = defaultEmbedClient;

export function setEmbedClient(client: EmbedClient | null): void {
  activeEmbedClient = client ?? defaultEmbedClient;
}

export function getEmbedClient(): EmbedClient {
  return activeEmbedClient;
}

export function isGeminiConfigured(): boolean {
  try {
    resolveApiKey();
    return true;
  } catch {
    return false;
  }
}

// ─── Embed pipeline ─────────────────────────────────────────────────

export interface EmbedPageResult {
  pageId: string;
  chunks: number;
  skipped?: boolean;
  error?: string;
}

/**
 * Embed a single page: chunk, call Gemini, persist vectors. Idempotent — always
 * deletes existing rows for the page first. Non-throwing on failure; callers
 * (wiki create/update hooks) should never have saves blocked by embedding
 * errors. Returns a result envelope with `skipped=true` when the API key is
 * not configured.
 */
export async function embedPage(
  projectId: string,
  page: { id: string; title: string; content: string },
  client: EmbedClient = activeEmbedClient,
): Promise<EmbedPageResult> {
  const s = stmts as Stmts;

  // Build the full text: title carries meaning for search.
  const fullText = `# ${page.title}\n\n${page.content || ''}`.trim();
  const chunks = chunkMarkdown(fullText);

  if (chunks.length === 0) {
    s.deleteWikiEmbeddingsByPage.run(page.id);
    return { pageId: page.id, chunks: 0 };
  }

  if (!isGeminiConfigured()) {
    return { pageId: page.id, chunks: 0, skipped: true, error: 'GEMINI_API_KEY missing' };
  }

  try {
    const vectors = await client.embedTexts(
      chunks.map((c) => c.text),
      'RETRIEVAL_DOCUMENT',
    );
    if (vectors.length !== chunks.length) {
      throw new Error(`Gemini returned ${vectors.length} embeddings for ${chunks.length} chunks`);
    }

    const insertAll = (db as Database.Database).transaction(
      (rows: { idx: number; text: string; buf: Buffer }[]) => {
        s.deleteWikiEmbeddingsByPage.run(page.id);
        for (const r of rows) {
          s.upsertWikiEmbedding.run(page.id, projectId, r.idx, r.text, r.buf, DEFAULT_MODEL);
        }
      },
    );

    insertAll(
      chunks.map((c, i) => ({
        idx: c.idx,
        text: c.text,
        buf: encodeEmbedding(vectors[i]!.values),
      })),
    );

    return { pageId: page.id, chunks: chunks.length };
  } catch (err) {
    const message = (err as Error).message;
    console.warn('[wiki-embeddings] embedPage failed for', page.id, message);
    return { pageId: page.id, chunks: 0, error: message };
  }
}

/**
 * Fire-and-forget embedding trigger invoked from wiki save hooks. Swallows all
 * errors after logging — saves must never block on embedding.
 */
export function scheduleEmbedPage(
  projectId: string,
  page: { id: string; title: string; content: string },
): void {
  // Run on next tick so the HTTP response isn't held. No retry; the backfill
  // endpoint exists for manual re-runs.
  setImmediate(() => {
    embedPage(projectId, page).catch((e: Error) => {
      console.warn('[wiki-embeddings] background embed error:', e.message);
    });
  });
}

export function deletePageEmbeddings(pageId: string): void {
  (stmts as Stmts).deleteWikiEmbeddingsByPage.run(pageId);
}

// ─── Hybrid ranker ──────────────────────────────────────────────────

/**
 * Normalize a list of scores to [0, 1] using min-max. Returns an identity map
 * when all scores are equal (avoids divide-by-zero).
 */
export function normalizeScores(scores: number[]): number[] {
  if (scores.length === 0) return [];
  let min = Infinity;
  let max = -Infinity;
  for (const s of scores) {
    if (s < min) min = s;
    if (s > max) max = s;
  }
  const range = max - min;
  if (range === 0) return scores.map(() => 1);
  return scores.map((s) => (s - min) / range);
}

export interface FtsHit {
  pageId: string;
  page: WikiPageRow;
  bm25Rank: number; // FTS5 `rank` — lower = better, typically negative
  snippet?: string;
}

export interface SemanticHit {
  pageId: string;
  chunkIdx: number;
  chunkText: string;
  score: number; // cosine similarity, [-1, 1]
}

export interface RankedResult {
  page: WikiPageRow;
  score: number;
  ftsScore: number;
  semanticScore: number;
  /** Raw cosine similarity (pre-normalization) of the best chunk; see `SearchResultRow.rawSemanticScore`. */
  rawSemanticScore?: number;
  matchedChunk?: string;
  snippet?: string;
}

/**
 * Blend FTS hits + semantic hits into a single ranked list. Weight defaults to
 * 50/50. FTS ranks are inverted (lower is better) and both streams are
 * min-max normalized before the weighted sum. Pages missing from one stream
 * get a 0 contribution from that side.
 */
export function rankHybrid(
  fts: FtsHit[],
  semantic: SemanticHit[],
  pageLookup: Map<string, WikiPageRow>,
  opts: { ftsWeight?: number; semanticWeight?: number; limit?: number } = {},
): RankedResult[] {
  const ftsWeight = opts.ftsWeight ?? 0.5;
  const semanticWeight = opts.semanticWeight ?? 0.5;
  const limit = opts.limit ?? 10;

  // Per-page best semantic score + the matching chunk text.
  const bestSemanticByPage = new Map<string, SemanticHit>();
  for (const s of semantic) {
    const prev = bestSemanticByPage.get(s.pageId);
    if (!prev || s.score > prev.score) bestSemanticByPage.set(s.pageId, s);
  }

  // FTS score = -rank (so higher is better). Then normalize across hits.
  const ftsPages = fts.map((h) => h.pageId);
  const ftsNorm = normalizeScores(fts.map((h) => -h.bm25Rank));
  const ftsScoreByPage = new Map<string, { score: number; snippet?: string }>();
  ftsPages.forEach((id, i) =>
    ftsScoreByPage.set(id, { score: ftsNorm[i]!, snippet: fts[i]!.snippet }),
  );

  const semPages = [...bestSemanticByPage.keys()];
  const semNorm = normalizeScores(semPages.map((id) => bestSemanticByPage.get(id)!.score));
  const semScoreByPage = new Map<string, number>();
  semPages.forEach((id, i) => semScoreByPage.set(id, semNorm[i]!));

  const allPageIds = new Set<string>([...ftsPages, ...semPages]);
  const results: RankedResult[] = [];

  for (const pageId of allPageIds) {
    const page = pageLookup.get(pageId);
    if (!page) continue;
    const ftsS = ftsScoreByPage.get(pageId)?.score ?? 0;
    const semS = semScoreByPage.get(pageId) ?? 0;
    const blended = ftsS * ftsWeight + semS * semanticWeight;
    results.push({
      page,
      score: blended,
      ftsScore: ftsS,
      semanticScore: semS,
      rawSemanticScore: bestSemanticByPage.get(pageId)?.score,
      matchedChunk: bestSemanticByPage.get(pageId)?.chunkText,
      snippet: ftsScoreByPage.get(pageId)?.snippet,
    });
  }

  results.sort((a, b) => b.score - a.score);
  return results.slice(0, limit);
}

// ─── Search drivers ─────────────────────────────────────────────────

function runFts(projectId: string, query: string, limit: number): FtsHit[] {
  try {
    const rows = (db as Database.Database)
      .prepare(
        `
        SELECT wp.id, wp.project_id, wp.title, wp.slug, wp.content, wp.category,
               wp.updated_by, wp.created_at, wp.updated_at,
               snippet(wiki_pages_fts, 1, '<mark>', '</mark>', '...', 40) as snippet,
               rank
        FROM wiki_pages_fts fts
        JOIN wiki_pages wp ON wp.rowid = fts.rowid
        WHERE wiki_pages_fts MATCH ? AND wp.project_id = ?
        ORDER BY rank
        LIMIT ?
      `,
      )
      .all(query, projectId, limit) as (WikiPageRow & {
      snippet: string;
      rank: number;
    })[];
    return rows.map((r) => ({
      pageId: r.id,
      page: r,
      bm25Rank: r.rank,
      snippet: r.snippet,
    }));
  } catch {
    return [];
  }
}

function runSemantic(projectId: string, queryVector: number[], limit: number): SemanticHit[] {
  const s = stmts as Stmts;
  // Filter to the active embedding model in SQL. Embedding spaces across Gemini
  // models (e.g. text-embedding-004 → gemini-embedding-001) are incompatible and
  // have different dimensionalities, so mismatched rows are dead weight until a
  // backfill rewrites them under DEFAULT_MODEL. Excluding them in the query means
  // we never load or decode their BLOBs on the retrieval hot path.
  const rows = s.getWikiEmbeddingsByProject.all(projectId, DEFAULT_MODEL) as EmbeddingRow[];
  if (rows.length === 0) return [];
  const q = new Float32Array(queryVector);
  const scored = rows.map((r) => {
    const vec = decodeEmbedding(r.embedding);
    return {
      pageId: r.page_id,
      chunkIdx: r.chunk_idx,
      chunkText: r.chunk_text,
      score: cosineSimilarity(q, vec),
    };
  });
  scored.sort((a, b) => b.score - a.score);
  // Over-fetch so rankHybrid still has good coverage per page after dedup.
  return scored.slice(0, Math.max(limit * 5, 25));
}

function getPageLookup(pageIds: string[]): Map<string, WikiPageRow> {
  if (pageIds.length === 0) return new Map();
  const placeholders = pageIds.map(() => '?').join(',');
  const rows = (db as Database.Database)
    .prepare(`SELECT * FROM wiki_pages WHERE id IN (${placeholders})`)
    .all(...pageIds) as WikiPageRow[];
  return new Map(rows.map((r) => [r.id, r]));
}

export async function searchWiki(
  projectId: string,
  query: string,
  opts: {
    mode?: SearchMode;
    limit?: number;
    client?: EmbedClient;
    ftsWeight?: number;
    semanticWeight?: number;
  } = {},
): Promise<SearchResultRow[]> {
  const mode: SearchMode = opts.mode ?? 'hybrid';
  const limit = opts.limit ?? 10;
  const client = opts.client ?? activeEmbedClient;

  if (!query || !query.trim()) return [];

  // FTS-only path preserves legacy semantics for skill callers.
  if (mode === 'fts') {
    const fts = runFts(projectId, query, limit);
    return fts.map((h) => ({
      id: h.page.id,
      project_id: h.page.project_id,
      title: h.page.title,
      slug: h.page.slug,
      category: h.page.category,
      updated_by: h.page.updated_by,
      created_at: h.page.created_at,
      updated_at: h.page.updated_at,
      score: -h.bm25Rank,
      ftsScore: -h.bm25Rank,
      snippet: h.snippet,
    }));
  }

  // Both semantic and hybrid require a query embedding. If the key isn't
  // configured, fall back to FTS so the endpoint still returns something.
  let queryVector: number[] | null = null;
  if (isGeminiConfigured()) {
    try {
      const [vec] = await client.embedTexts([query], 'RETRIEVAL_QUERY');
      queryVector = vec?.values ?? null;
    } catch (err) {
      console.warn('[wiki-embeddings] query embed failed:', (err as Error).message);
    }
  }

  if (!queryVector) {
    // Degrade gracefully — semantic mode with no embeddings returns nothing;
    // hybrid falls back to FTS.
    if (mode === 'semantic') return [];
    const fts = runFts(projectId, query, limit);
    return fts.map((h) => ({
      id: h.page.id,
      project_id: h.page.project_id,
      title: h.page.title,
      slug: h.page.slug,
      category: h.page.category,
      updated_by: h.page.updated_by,
      created_at: h.page.created_at,
      updated_at: h.page.updated_at,
      score: -h.bm25Rank,
      ftsScore: -h.bm25Rank,
      snippet: h.snippet,
    }));
  }

  const semantic = runSemantic(projectId, queryVector, limit);

  if (mode === 'semantic') {
    const pageIds = [...new Set(semantic.map((s) => s.pageId))].slice(0, limit);
    const lookup = getPageLookup(pageIds);
    const bestByPage = new Map<string, SemanticHit>();
    for (const h of semantic) {
      const prev = bestByPage.get(h.pageId);
      if (!prev || h.score > prev.score) bestByPage.set(h.pageId, h);
    }
    return pageIds
      .map((id) => {
        const page = lookup.get(id);
        const hit = bestByPage.get(id);
        if (!page || !hit) return null;
        return {
          id: page.id,
          project_id: page.project_id,
          title: page.title,
          slug: page.slug,
          category: page.category,
          updated_by: page.updated_by,
          created_at: page.created_at,
          updated_at: page.updated_at,
          score: hit.score,
          semanticScore: hit.score,
          rawSemanticScore: hit.score,
          matchedChunk: hit.chunkText,
        } as SearchResultRow;
      })
      .filter((r): r is SearchResultRow => r !== null)
      .slice(0, limit);
  }

  // Hybrid
  const fts = runFts(projectId, query, Math.max(limit, 20));
  const allIds = new Set<string>([...fts.map((h) => h.pageId), ...semantic.map((h) => h.pageId)]);
  const lookup = getPageLookup([...allIds]);
  const ranked = rankHybrid(fts, semantic, lookup, {
    ftsWeight: opts.ftsWeight,
    semanticWeight: opts.semanticWeight,
    limit,
  });
  return ranked.map((r) => ({
    id: r.page.id,
    project_id: r.page.project_id,
    title: r.page.title,
    slug: r.page.slug,
    category: r.page.category,
    updated_by: r.page.updated_by,
    created_at: r.page.created_at,
    updated_at: r.page.updated_at,
    score: r.score,
    ftsScore: r.ftsScore,
    semanticScore: r.semanticScore,
    rawSemanticScore: r.rawSemanticScore,
    matchedChunk: r.matchedChunk,
    snippet: r.snippet,
  }));
}

// ─── Backfill ───────────────────────────────────────────────────────

export interface BackfillResult {
  projectId: string;
  total: number;
  embedded: number;
  skipped: number;
  errors: { pageId: string; error: string }[];
}

/**
 * Re-embed every page in a project. Idempotent; safe to run repeatedly. Serial
 * by default to respect Gemini RPM (free-tier embedding RPM is 100 which is
 * plenty for our size — we still keep it sequential to simplify error recovery
 * and logging).
 */
export async function backfillProject(
  projectId: string,
  client: EmbedClient = activeEmbedClient,
): Promise<BackfillResult> {
  const s = stmts as Stmts;
  const pages = s.getWikiPages.all(projectId) as WikiPageRow[];
  const result: BackfillResult = {
    projectId,
    total: pages.length,
    embedded: 0,
    skipped: 0,
    errors: [],
  };

  for (const page of pages) {
    // getWikiPages omits content — fetch the full row.
    const full = s.getWikiPageById.get(page.id) as WikiPageRow | undefined;
    if (!full) continue;
    const r = await embedPage(projectId, full, client);
    if (r.error) {
      if (r.skipped) {
        result.skipped++;
      } else {
        result.errors.push({ pageId: page.id, error: r.error });
      }
    } else {
      result.embedded++;
    }
  }

  return result;
}
