import { describe, it, expect, vi } from 'vitest';
import {
  decodeHtmlEntities,
  MAX_WEB_SEARCH_BLOCK_CHARS,
  parseDdgHtml,
  resolveDdgHref,
  runWebSearchForQuery,
} from './web-search.js';

/** A minimal DuckDuckGo HTML results page with two organic results. */
function ddgHtml(rows: Array<{ href: string; title: string; snippet: string }>): string {
  const blocks = rows
    .map(
      (r) => `
    <div class="result results_links results_links_deep web-result">
      <h2 class="result__title">
        <a rel="nofollow" class="result__a" href="${r.href}">${r.title}</a>
      </h2>
      <a class="result__snippet" href="${r.href}">${r.snippet}</a>
    </div>`,
    )
    .join('\n');
  return `<!DOCTYPE html><html><body>${blocks}</body></html>`;
}

describe('decodeHtmlEntities', () => {
  it('decodes named and numeric entities', () => {
    expect(decodeHtmlEntities('a &amp; b &lt;c&gt; &quot;d&quot; &#39;e&#39;')).toBe(
      'a & b <c> "d" \'e\'',
    );
    expect(decodeHtmlEntities('caf&#233;')).toBe('café');
    expect(decodeHtmlEntities('&#x2F;path')).toBe('/path');
  });

  it('leaves unknown entities untouched', () => {
    expect(decodeHtmlEntities('&notreal;')).toBe('&notreal;');
  });
});

describe('resolveDdgHref', () => {
  it('unwraps the uddg redirect to the real destination', () => {
    const href = '//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fpage%3Fa%3D1&amp;rut=abc';
    expect(resolveDdgHref(href)).toBe('https://example.com/page?a=1');
  });

  it('passes through already-direct links', () => {
    expect(resolveDdgHref('https://example.com/x')).toBe('https://example.com/x');
  });
});

describe('parseDdgHtml', () => {
  it('extracts title, unwrapped link, and snippet in order', () => {
    const html = ddgHtml([
      {
        href: '//duckduckgo.com/l/?uddg=https%3A%2F%2Fa.example',
        title: 'Title A',
        snippet: 'snippet <b>a</b>',
      },
      {
        href: '//duckduckgo.com/l/?uddg=https%3A%2F%2Fb.example',
        title: 'Title B',
        snippet: 'snippet b',
      },
    ]);
    const results = parseDdgHtml(html);
    expect(results).toHaveLength(2);
    expect(results[0]).toEqual({
      title: 'Title A',
      link: 'https://a.example',
      snippet: 'snippet a',
    });
    expect(results[1].link).toBe('https://b.example');
  });

  it('keeps each real result on its own snippet across an interleaved y.js ad row', () => {
    // Real A, then a DuckDuckGo ad (y.js) that carries ITS OWN snippet, then
    // real B. The ad's anchor is skipped; its snippet must not shift onto B.
    const html = `<!DOCTYPE html><html><body>
      <div class="result results_links web-result">
        <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fa.example">Title A</a>
        <a class="result__snippet" href="#">snippet a</a>
      </div>
      <div class="result result--ad">
        <a rel="nofollow" class="result__a" href="https://duckduckgo.com/y.js?ad=1">Sponsored</a>
        <a class="result__snippet" href="#">buy now ad snippet</a>
      </div>
      <div class="result results_links web-result">
        <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fb.example">Title B</a>
        <a class="result__snippet" href="#">snippet b</a>
      </div>
    </body></html>`;
    const results = parseDdgHtml(html);
    expect(results).toEqual([
      { title: 'Title A', link: 'https://a.example', snippet: 'snippet a' },
      { title: 'Title B', link: 'https://b.example', snippet: 'snippet b' },
    ]);
  });

  it('does not borrow a later result’s snippet when a result has none', () => {
    // First result has a title anchor but NO result__snippet; the second does.
    // The first must report an undefined snippet, not steal the second's.
    const html = `<!DOCTYPE html><html><body>
      <div class="result results_links web-result">
        <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fa.example">Title A</a>
      </div>
      <div class="result results_links web-result">
        <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fb.example">Title B</a>
        <a class="result__snippet" href="#">snippet b</a>
      </div>
    </body></html>`;
    const results = parseDdgHtml(html);
    expect(results).toHaveLength(2);
    expect(results[0]).toEqual({
      title: 'Title A',
      link: 'https://a.example',
      snippet: undefined,
    });
    expect(results[1].snippet).toBe('snippet b');
  });

  it('returns empty for a page with no organic results (e.g. CAPTCHA)', () => {
    expect(parseDdgHtml('<html><body>no results here</body></html>')).toEqual([]);
  });
});

describe('runWebSearchForQuery', () => {
  it('does not require any API key', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(ddgHtml([{ href: 'https://a.example', title: 'A', snippet: 'snippet a' }]), {
          status: 200,
          headers: { 'Content-Type': 'text/html' },
        }),
    );
    const r = await runWebSearchForQuery('  my query  ', fetchMock as typeof fetch);
    expect(r.consumedCall).toBe(true);
    expect(r.markdown).toContain('## Retrieved Web Results');
    expect(r.markdown).toContain('my query');
    expect(r.markdown).toContain('https://a.example');
    expect(r.markdown).toContain('snippet a');
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://html.duckduckgo.com/html/');
    expect(init.method).toBe('POST');
    // Query is sent as a form field; no auth header of any kind.
    expect(init.headers as Record<string, string>).not.toHaveProperty('X-API-KEY');
    expect(new URLSearchParams(init.body as string).get('q')).toBe('my query');
  });

  it('skips an empty query without consuming a call', async () => {
    const fetchMock = vi.fn();
    const r = await runWebSearchForQuery('   ', fetchMock as unknown as typeof fetch);
    expect(r.consumedCall).toBe(false);
    expect(r.markdown).toBe('');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('maps HTTP errors to errorMarkdown and consumes the call', async () => {
    const fetchMock = vi.fn(async () => new Response('bad', { status: 429 }));
    const r = await runWebSearchForQuery('q', fetchMock as typeof fetch);
    expect(r.consumedCall).toBe(true);
    expect(r.errorMarkdown).toMatch(/429/);
  });

  it('counts transport failures toward the session cap', async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error('network down');
    });
    const r = await runWebSearchForQuery('q', fetchMock as typeof fetch);
    expect(r.consumedCall).toBe(true);
    expect(r.errorMarkdown).toMatch(/network down/);
  });

  it('reports no organic results without erroring', async () => {
    const fetchMock = vi.fn(
      async () => new Response('<html><body>captcha</body></html>', { status: 200 }),
    );
    const r = await runWebSearchForQuery('q', fetchMock as typeof fetch);
    expect(r.consumedCall).toBe(true);
    expect(r.errorMarkdown).toBeUndefined();
    expect(r.markdown).toContain('No organic results returned');
  });

  it('clips oversized markdown block', async () => {
    const hugeSnippet = 'Z'.repeat(MAX_WEB_SEARCH_BLOCK_CHARS + 500);
    const fetchMock = vi.fn(
      async () =>
        new Response(ddgHtml([{ href: 'https://z', title: 'T', snippet: hugeSnippet }]), {
          status: 200,
        }),
    );
    const r = await runWebSearchForQuery('q', fetchMock as typeof fetch);
    expect(Buffer.byteLength(r.markdown, 'utf-8')).toBeLessThanOrEqual(
      MAX_WEB_SEARCH_BLOCK_CHARS + 64,
    );
    expect(r.markdown).toContain('[Truncated: web search block size cap]');
  });

  it('truncates at byte cap without splitting UTF-8 codepoints', async () => {
    const snowman = '☃';
    const hugeTitle = snowman.repeat(5000);
    const fetchMock = vi.fn(
      async () =>
        new Response(ddgHtml([{ href: 'https://x', title: hugeTitle, snippet: '' }]), {
          status: 200,
        }),
    );
    const r = await runWebSearchForQuery('q', fetchMock as typeof fetch);
    expect(r.markdown).toContain('[Truncated: web search block size cap]');
    expect(r.markdown).not.toContain('�');
  });
});
