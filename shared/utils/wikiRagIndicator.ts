/**
 * Shared parsing for the automatic wiki-RAG indicator persisted on assistant
 * messages (`metadata.wikiRag`). Web and mobile both render a "Consulted wiki"
 * chip from this; keeping the parse pure and shared means the two clients can't
 * drift. Mirrors `WikiRagIndicator` in `server/wiki-rag.ts` (the server is the
 * producer) — keep the shapes in sync.
 */

export interface WikiRagIndicatorPage {
  title: string;
  slug: string;
  category: string;
  /** Min-max normalized blended score (as shown in the injected block). */
  score: number;
  /** Raw cosine similarity of the best chunk, when available. */
  rawScore?: number;
}

export interface WikiRagIndicator {
  /** `consulted` = pages cleared the relevance floor and were injected; `no_match` = retrieval ran but nothing cleared it. */
  status: 'consulted' | 'no_match';
  /** Number of pages injected into the prompt (0 when `no_match`). */
  retrieved: number;
  /** Pages injected, best-first (empty when `no_match`). */
  pages: WikiRagIndicatorPage[];
  /** Query used for retrieval (the user's message, normalized). */
  query: string;
}

function coercePage(raw: unknown): WikiRagIndicatorPage | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.title !== 'string' || typeof o.slug !== 'string') return null;
  return {
    title: o.title,
    slug: o.slug,
    category: typeof o.category === 'string' ? o.category : '',
    score: typeof o.score === 'number' && Number.isFinite(o.score) ? o.score : 0,
    ...(typeof o.rawScore === 'number' && Number.isFinite(o.rawScore)
      ? { rawScore: o.rawScore }
      : {}),
  };
}

/**
 * Extract the wiki-RAG indicator from a message's `metadata`, which may arrive
 * as a raw JSON string (REST / DB) or an already-parsed object (defensive).
 * Returns null when absent or malformed — callers render no chip in that case.
 */
export function parseWikiRagIndicator(metadata: unknown): WikiRagIndicator | null {
  if (metadata == null) return null;
  let obj: unknown = metadata;
  if (typeof metadata === 'string') {
    const trimmed = metadata.trim();
    if (!trimmed) return null;
    try {
      obj = JSON.parse(trimmed);
    } catch {
      return null;
    }
  }
  if (!obj || typeof obj !== 'object') return null;
  const wikiRag = (obj as Record<string, unknown>).wikiRag;
  if (!wikiRag || typeof wikiRag !== 'object') return null;
  const w = wikiRag as Record<string, unknown>;
  const status = w.status === 'consulted' || w.status === 'no_match' ? w.status : null;
  if (!status) return null;
  const pages = Array.isArray(w.pages)
    ? w.pages.map(coercePage).filter((p): p is WikiRagIndicatorPage => p !== null)
    : [];
  const retrieved =
    typeof w.retrieved === 'number' && Number.isFinite(w.retrieved) ? w.retrieved : pages.length;
  return {
    status,
    retrieved,
    pages,
    query: typeof w.query === 'string' ? w.query : '',
  };
}
