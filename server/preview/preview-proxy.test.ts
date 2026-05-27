import { describe, it, expect } from 'vitest';
import { injectHtmlPreviewBaseHref, parsePreviewProxySessionId } from './preview-proxy.js';

describe('parsePreviewProxySessionId', () => {
  it('parses session id from proxy mount paths', () => {
    expect(parsePreviewProxySessionId('/api/sessions/sess%2D1/preview/proxy/')).toBe('sess-1');
    expect(parsePreviewProxySessionId('/api/sessions/abc/preview/proxy/main.js')).toBe('abc');
    expect(parsePreviewProxySessionId('/api/sessions/abc/preview/proxy/ws?token=x')).toBe('abc');
  });

  it('returns null for unrelated paths', () => {
    expect(parsePreviewProxySessionId('/api/sessions/abc/preview/start')).toBeNull();
    expect(parsePreviewProxySessionId('/')).toBeNull();
  });
});

describe('injectHtmlPreviewBaseHref', () => {
  it('inserts base href under head', () => {
    const html = '<html><head><title>x</title></head><body></body></html>';
    const out = injectHtmlPreviewBaseHref(html, 'sess-1');
    expect(out).toContain('<base href="/api/sessions/sess-1/preview/proxy/">');
    expect(out.indexOf('<base')).toBeLessThan(out.indexOf('<title'));
  });

  it('overrides an existing <base href> so relative URLs resolve under the proxy mount', () => {
    // Angular/Vite/CRA index.html templates ship with <base href="/"> by
    // default. Leaving that intact behind the path-prefix proxy would
    // make every relative asset (main.js, styles.css, manifest.webmanifest)
    // resolve at the Hub root, where the browser receives the Hub SPA
    // fallback HTML instead of the asset → white-screen preview iframe
    // with a "Manifest: Line 1, column 1, Syntax error" console entry.
    const html = '<html><head><base href="/"><title>Preview</title></head></html>';
    const out = injectHtmlPreviewBaseHref(html, 'sess-1');
    expect(out).toContain('<base href="/api/sessions/sess-1/preview/proxy/">');
    expect(out).not.toContain('<base href="/">');
    expect(out.match(/<base\b/gi)?.length).toBe(1);
  });

  it('replaces a self-closing base tag with extra attributes too', () => {
    const html = '<html><head><base href="/" target="_self"/></head></html>';
    const out = injectHtmlPreviewBaseHref(html, 'sess-1');
    expect(out).toContain('<base href="/api/sessions/sess-1/preview/proxy/">');
    expect(out).not.toContain('href="/"');
    expect(out.match(/<base\b/gi)?.length).toBe(1);
  });
});
