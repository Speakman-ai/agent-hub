/** Parse `metadata.wikiRag`. Keep in sync with `WikiRagIndicator` in `server/wiki-rag.ts`. */

export interface WikiRagIndicatorPage {
  title: string;
  slug: string;
  category: string;
  /** Min-max blended score shown in the injected block. */
  score: number;
  /** Cosine similarity of the best chunk, when available. */
  rawScore?: number;
}

export interface WikiRagIndicator {
  /** `consulted`: pages injected. `no_match`: retrieval ran, nothing cleared the floor. */
  status: 'consulted' | 'no_match';
  retrieved: number;
  pages: WikiRagIndicatorPage[];
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

/** Parse wiki-RAG metadata (JSON string or object). Null when absent or malformed. */
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
