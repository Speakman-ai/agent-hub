/**
 * Host-side web search for the ReAct loop (Serper Google Search API).
 *
 * @see https://serper.dev — POST `https://google.serper.dev/search` with `X-API-KEY` and JSON `{ "q", "num" }`.
 */

import { clipUtf8StringToMaxBytes } from './utf8-clip.js';

const SERPER_URL = 'https://google.serper.dev/search';

export const MAX_WEB_SEARCH_QUERY_CHARS = 400;
export const MAX_WEB_SEARCH_RESULTS = 5;
/** Cap formatted markdown returned to the model (UTF-8 bytes). */
export const MAX_WEB_SEARCH_BLOCK_CHARS = 8000;
/** Hard cap on Serper calls per chat session (cost / abuse control). */
export const MAX_WEB_SEARCH_CALLS_PER_SESSION = 16;

export function getWebSearchApiKey(): string | null {
  const k = process.env.SERPER_API_KEY?.trim() || process.env.WEB_SEARCH_API_KEY?.trim() || '';
  return k || null;
}

function clipQuery(raw: string): string {
  const q = raw.replace(/\s+/g, ' ').trim();
  if (q.length <= MAX_WEB_SEARCH_QUERY_CHARS) return q;
  return `${q.slice(0, Math.max(0, MAX_WEB_SEARCH_QUERY_CHARS - 1)).trimEnd()}…`;
}

interface SerperOrganic {
  title?: string;
  link?: string;
  snippet?: string;
}

function formatOrganic(query: string, items: SerperOrganic[]): string {
  const lines: string[] = ['## Retrieved Web Results', '', `Query: ${query}`, ''];
  if (items.length === 0) {
    lines.push('_(No organic results returned.)_');
    return lines.join('\n');
  }
  for (let i = 0; i < items.length; i++) {
    const row = items[i];
    const title = (row.title || '(no title)').trim();
    const link = (row.link || '').trim();
    const snippet = (row.snippet || '').trim();
    lines.push(`### ${i + 1}. ${title}`);
    if (link) lines.push(link);
    if (snippet) lines.push(snippet);
    lines.push('');
  }
  let body = lines.join('\n').trim();
  const bytes = Buffer.byteLength(body, 'utf-8');
  if (bytes > MAX_WEB_SEARCH_BLOCK_CHARS) {
    const marker = '\n\n[Truncated: web search block size cap]';
    const maxBody = MAX_WEB_SEARCH_BLOCK_CHARS - Buffer.byteLength(marker, 'utf-8');
    body = clipUtf8StringToMaxBytes(body, Math.max(0, maxBody)) + marker;
  }
  return body;
}

export interface WebSearchRunResult {
  /** Markdown block to inject when search succeeded (may be empty organic). */
  markdown: string;
  /** Set when the search was not performed or the HTTP/API failed. */
  errorMarkdown?: string;
  /**
   * True when this attempt counts toward `MAX_WEB_SEARCH_CALLS_PER_SESSION`:
   * any outbound Serper try after a configured API key and non-empty query
   * (success, HTTP error, non-JSON body, transport failure, or timeout).
   * False only when the call was skipped (no key, empty query).
   */
  consumedCall: boolean;
}

/**
 * Runs a single Serper search. When no API key is configured, returns an error
 * markdown snippet and does not consume a budget slot.
 */
export async function runWebSearchForQuery(
  query: string,
  fetchImpl: typeof fetch = fetch,
): Promise<WebSearchRunResult> {
  const key = getWebSearchApiKey();
  if (!key) {
    return {
      markdown: '',
      errorMarkdown:
        '## Web Search Error\nWeb search is not configured on this Agent Hub server. ' +
        'Set `SERPER_API_KEY` (or `WEB_SEARCH_API_KEY`) to enable the ReAct `web` tool. ' +
        'See https://serper.dev for an API key.',
      consumedCall: false,
    };
  }

  const q = clipQuery(query);
  if (!q) {
    return {
      markdown: '',
      errorMarkdown: '## Web Search Error\nEmpty search query after normalization.',
      consumedCall: false,
    };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  try {
    const res = await fetchImpl(SERPER_URL, {
      method: 'POST',
      headers: {
        'X-API-KEY': key,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ q, num: MAX_WEB_SEARCH_RESULTS }),
      signal: controller.signal,
    });

    const text = await res.text();
    if (!res.ok) {
      const errSnippet = text.replace(/\s+/g, ' ').trim().slice(0, 500);
      return {
        markdown: '',
        errorMarkdown: `## Web Search Error\nSerper HTTP ${res.status}: ${errSnippet}`,
        consumedCall: true,
      };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text) as unknown;
    } catch {
      return {
        markdown: '',
        errorMarkdown: '## Web Search Error\nSerper returned non-JSON response.',
        consumedCall: true,
      };
    }

    const organicRaw =
      parsed && typeof parsed === 'object' && parsed !== null && 'organic' in parsed
        ? (parsed as { organic: unknown }).organic
        : null;
    const organic: SerperOrganic[] = Array.isArray(organicRaw)
      ? organicRaw.filter(
          (x): x is SerperOrganic => x && typeof x === 'object' && !Array.isArray(x),
        )
      : [];

    return {
      markdown: formatOrganic(q, organic),
      consumedCall: true,
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      markdown: '',
      errorMarkdown: `## Web Search Error\nRequest failed: ${msg}`,
      // Count any outbound attempt (timeouts, DNS, TLS, etc.) toward the session cap.
      consumedCall: true,
    };
  } finally {
    clearTimeout(timer);
  }
}
