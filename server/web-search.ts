/**
 * Host-side web search for the ReAct loop.
 *
 * Keyless: queries DuckDuckGo's no-JavaScript HTML results page
 * (`https://html.duckduckgo.com/html/`) and parses the organic result anchors.
 * No API key or account is required. This is an unofficial, best-effort
 * integration — DuckDuckGo can serve a CAPTCHA / anomaly page under heavy
 * automated load, in which case zero organic results are returned.
 */

import { clipUtf8StringToMaxBytes } from './utf8-clip.js';

const DDG_HTML_URL = 'https://html.duckduckgo.com/html/';
/** DuckDuckGo rejects requests with an empty/obviously-bot User-Agent. */
const USER_AGENT = 'Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0';

export const MAX_WEB_SEARCH_QUERY_CHARS = 400;
export const MAX_WEB_SEARCH_RESULTS = 5;
/** Cap formatted markdown returned to the model (UTF-8 bytes). */
export const MAX_WEB_SEARCH_BLOCK_CHARS = 8000;
/** Hard cap on web search calls per chat session (abuse / rate-limit control). */
export const MAX_WEB_SEARCH_CALLS_PER_SESSION = 16;

function clipQuery(raw: string): string {
  const q = raw.replace(/\s+/g, ' ').trim();
  if (q.length <= MAX_WEB_SEARCH_QUERY_CHARS) return q;
  return `${q.slice(0, Math.max(0, MAX_WEB_SEARCH_QUERY_CHARS - 1)).trimEnd()}…`;
}

interface WebResult {
  title?: string;
  link?: string;
  snippet?: string;
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  '#39': "'",
  '#x27': "'",
  '#x2F': '/',
};

/** Decode the small set of HTML entities DuckDuckGo emits in titles/snippets. */
export function decodeHtmlEntities(input: string): string {
  return input.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, entity: string) => {
    const named = NAMED_ENTITIES[entity];
    if (named !== undefined) return named;
    if (entity[0] === '#') {
      const isHex = entity[1] === 'x' || entity[1] === 'X';
      const code = parseInt(isHex ? entity.slice(2) : entity.slice(1), isHex ? 16 : 10);
      if (Number.isFinite(code) && code > 0 && code <= 0x10ffff) {
        try {
          return String.fromCodePoint(code);
        } catch {
          return match;
        }
      }
    }
    return match;
  });
}

/** Strip HTML tags, decode entities, and collapse whitespace. */
function cleanText(html: string): string {
  return decodeHtmlEntities(html.replace(/<[^>]*>/g, ''))
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * DuckDuckGo wraps result links in a redirect (`//duckduckgo.com/l/?uddg=<enc>`).
 * Unwrap to the real destination URL; leave already-direct links untouched.
 */
export function resolveDdgHref(href: string): string {
  let raw = decodeHtmlEntities(href.trim());
  if (raw.startsWith('//')) raw = `https:${raw}`;
  try {
    const url = new URL(raw);
    const uddg = url.searchParams.get('uddg');
    if (uddg) return uddg;
  } catch {
    // Fall through to returning the raw href.
  }
  return raw;
}

/** Parse organic results out of DuckDuckGo's HTML results page. */
export function parseDdgHtml(html: string): WebResult[] {
  const results: WebResult[] = [];
  // Each result title is a `result__a` anchor; its snippet (`result__snippet`)
  // lives in the same result block, after the anchor and before the next one.
  // Correlate the two per-block rather than index-joining two global scans, so
  // a skipped row (y.js ad, missing href) or a result with no snippet can never
  // shift snippets onto the wrong title/URL.
  const anchorRe = /<a\b([^>]*\bclass="[^"]*\bresult__a\b[^"]*"[^>]*)>([\s\S]*?)<\/a>/gi;
  const snippetRe = /<a\b[^>]*\bclass="[^"]*\bresult__snippet\b[^"]*"[^>]*>([\s\S]*?)<\/a>/i;

  const anchors: Array<{ end: number; start: number; attrs: string; inner: string }> = [];
  let am: RegExpExecArray | null;
  while ((am = anchorRe.exec(html)) !== null) {
    anchors.push({ start: am.index, end: anchorRe.lastIndex, attrs: am[1], inner: am[2] });
  }

  for (let i = 0; i < anchors.length && results.length < MAX_WEB_SEARCH_RESULTS; i++) {
    const a = anchors[i];
    const hrefMatch = /href="([^"]*)"/i.exec(a.attrs);
    if (!hrefMatch) continue;
    const link = resolveDdgHref(hrefMatch[1]);
    // Skip DuckDuckGo's own ad / internal links that carry no real destination.
    if (!link || link.startsWith('https://duckduckgo.com/y.js')) continue;
    // This result's block spans from just after its title anchor to the start
    // of the next title anchor (or end of document). A snippet found there
    // belongs to this result; if there is none, the field is left undefined.
    const blockEnd = i + 1 < anchors.length ? anchors[i + 1].start : html.length;
    const sm = snippetRe.exec(html.slice(a.end, blockEnd));
    results.push({
      title: cleanText(a.inner),
      link,
      snippet: sm ? cleanText(sm[1]) : undefined,
    });
  }
  return results;
}

function formatOrganic(query: string, items: WebResult[]): string {
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
  /** Set when the search was not performed or the HTTP request failed. */
  errorMarkdown?: string;
  /**
   * True when this attempt counts toward `MAX_WEB_SEARCH_CALLS_PER_SESSION`:
   * any outbound request (success, HTTP error, non-HTML body, transport
   * failure, or timeout). False only when the call was skipped (empty query).
   */
  consumedCall: boolean;
}

/**
 * Runs a single keyless DuckDuckGo search. No API key is required.
 */
export async function runWebSearchForQuery(
  query: string,
  fetchImpl: typeof fetch = fetch,
): Promise<WebSearchRunResult> {
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
    const res = await fetchImpl(DDG_HTML_URL, {
      method: 'POST',
      headers: {
        'User-Agent': USER_AGENT,
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'text/html',
      },
      body: new URLSearchParams({ q }).toString(),
      signal: controller.signal,
    });

    const text = await res.text();
    if (!res.ok) {
      const errSnippet = text.replace(/\s+/g, ' ').trim().slice(0, 500);
      return {
        markdown: '',
        errorMarkdown: `## Web Search Error\nDuckDuckGo HTTP ${res.status}: ${errSnippet}`,
        consumedCall: true,
      };
    }

    const organic = parseDdgHtml(text);
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
