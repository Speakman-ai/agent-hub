import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  getWebSearchApiKey,
  MAX_WEB_SEARCH_BLOCK_CHARS,
  runWebSearchForQuery,
} from './web-search.js';

const originalKey = process.env.SERPER_API_KEY;
const originalWebKey = process.env.WEB_SEARCH_API_KEY;

afterEach(() => {
  if (originalKey === undefined) delete process.env.SERPER_API_KEY;
  else process.env.SERPER_API_KEY = originalKey;
  if (originalWebKey === undefined) delete process.env.WEB_SEARCH_API_KEY;
  else process.env.WEB_SEARCH_API_KEY = originalWebKey;
});

describe('getWebSearchApiKey', () => {
  it('prefers SERPER_API_KEY over WEB_SEARCH_API_KEY', () => {
    process.env.SERPER_API_KEY = ' serp ';
    process.env.WEB_SEARCH_API_KEY = 'web';
    expect(getWebSearchApiKey()).toBe('serp');
  });

  it('falls back to WEB_SEARCH_API_KEY', () => {
    delete process.env.SERPER_API_KEY;
    process.env.WEB_SEARCH_API_KEY = 'w';
    expect(getWebSearchApiKey()).toBe('w');
  });
});

describe('runWebSearchForQuery', () => {
  it('returns configuration error when no API key', async () => {
    delete process.env.SERPER_API_KEY;
    delete process.env.WEB_SEARCH_API_KEY;
    const r = await runWebSearchForQuery('node lts', vi.fn() as typeof fetch);
    expect(r.consumedCall).toBe(false);
    expect(r.errorMarkdown).toMatch(/SERPER_API_KEY/);
    expect(r.markdown).toBe('');
  });

  it('formats organic results on success', async () => {
    process.env.SERPER_API_KEY = 'test-key';
    const fetchMock = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          organic: [
            { title: 'A', link: 'https://a.example', snippet: 'snippet a' },
            { title: 'B', link: 'https://b.example', snippet: 'snippet b' },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    });
    const r = await runWebSearchForQuery('  my query  ', fetchMock as typeof fetch);
    expect(r.consumedCall).toBe(true);
    expect(r.markdown).toContain('## Retrieved Web Results');
    expect(r.markdown).toContain('my query');
    expect(r.markdown).toContain('https://a.example');
    expect(r.markdown).toContain('snippet a');
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://google.serper.dev/search');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['X-API-KEY']).toBe('test-key');
    const body = JSON.parse(init.body as string);
    expect(body.q).toBe('my query');
  });

  it('maps HTTP errors to errorMarkdown and consumes call', async () => {
    process.env.SERPER_API_KEY = 'k';
    const fetchMock = vi.fn(async () => new Response('bad', { status: 401 }));
    const r = await runWebSearchForQuery('q', fetchMock as typeof fetch);
    expect(r.consumedCall).toBe(true);
    expect(r.errorMarkdown).toMatch(/401/);
  });

  it('counts transport failures toward the session cap', async () => {
    process.env.SERPER_API_KEY = 'k';
    const fetchMock = vi.fn(async () => {
      throw new Error('network down');
    });
    const r = await runWebSearchForQuery('q', fetchMock as typeof fetch);
    expect(r.consumedCall).toBe(true);
    expect(r.errorMarkdown).toMatch(/network down/);
  });

  it('clips oversized markdown block', async () => {
    process.env.SERPER_API_KEY = 'k';
    const hugeSnippet = 'Z'.repeat(MAX_WEB_SEARCH_BLOCK_CHARS + 500);
    const fetchMock = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          organic: [{ title: 'T', link: 'https://z', snippet: hugeSnippet }],
        }),
        { status: 200 },
      );
    });
    const r = await runWebSearchForQuery('q', fetchMock as typeof fetch);
    expect(Buffer.byteLength(r.markdown, 'utf-8')).toBeLessThanOrEqual(
      MAX_WEB_SEARCH_BLOCK_CHARS + 64,
    );
    expect(r.markdown).toContain('[Truncated: web search block size cap]');
  });

  it('truncates at byte cap without splitting UTF-8 codepoints', async () => {
    process.env.SERPER_API_KEY = 'k';
    const snowman = '\u2603';
    const hugeTitle = snowman.repeat(5000);
    const fetchMock = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          organic: [{ title: hugeTitle, link: 'https://x', snippet: '' }],
        }),
        { status: 200 },
      );
    });
    const r = await runWebSearchForQuery('q', fetchMock as typeof fetch);
    expect(r.markdown).toContain('[Truncated: web search block size cap]');
    expect(r.markdown).not.toContain('\uFFFD');
  });
});
