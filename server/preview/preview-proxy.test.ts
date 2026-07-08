import { describe, it, expect } from 'vitest';
import {
  applyIframeEmbedHeaders,
  buildFrameAncestorsCsp,
  injectHtmlPreviewBaseHref,
  parsePreviewProxySessionId,
} from './preview-proxy.js';

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

describe('buildFrameAncestorsCsp', () => {
  it('returns self-only when parent public URL is unset', () => {
    // Path-prefix deployment (parent and iframe share an origin) only
    // needs 'self' — no cross-origin embed.
    expect(buildFrameAncestorsCsp(undefined)).toBe(`frame-ancestors 'self'`);
    expect(buildFrameAncestorsCsp(null)).toBe(`frame-ancestors 'self'`);
    expect(buildFrameAncestorsCsp('')).toBe(`frame-ancestors 'self'`);
  });

  it('includes the parent origin (scheme + host) when configured', () => {
    expect(buildFrameAncestorsCsp('https://agenthub.dev.example.com')).toBe(
      `frame-ancestors 'self' https://agenthub.dev.example.com`,
    );
  });

  it('strips path/query from the parent URL — CSP frame-ancestors only honours origins', () => {
    expect(buildFrameAncestorsCsp('https://agenthub.example.com/some/path?foo=bar')).toBe(
      `frame-ancestors 'self' https://agenthub.example.com`,
    );
  });

  it('falls back to self-only on a malformed parent URL (fail-closed)', () => {
    // A bad publicUrl ("definitely not a url") must NOT widen the
    // frame-ancestors set — the iframe still has to load from
    // somewhere allowed, so the strictest interpretation is best.
    expect(buildFrameAncestorsCsp('definitely not a url')).toBe(`frame-ancestors 'self'`);
  });
});

describe('applyIframeEmbedHeaders', () => {
  it('drops upstream X-Frame-Options so it cannot override our CSP', () => {
    // Some upstream dev servers default to XFO: DENY. Browsers that
    // honour XFO ahead of CSP frame-ancestors (notably older Safari)
    // would block the iframe before our policy is consulted; strip
    // it to make the resulting behaviour predictable.
    const headers: Record<string, string | string[]> = {
      'x-frame-options': 'DENY',
      'content-type': 'text/html',
    };
    applyIframeEmbedHeaders(headers, 'https://parent.example.com');
    expect(headers['x-frame-options']).toBeUndefined();
    expect(headers['content-security-policy']).toContain(
      `frame-ancestors 'self' https://parent.example.com`,
    );
  });

  it('merges into an existing CSP, removing only the prior frame-ancestors', () => {
    const headers: Record<string, string | string[]> = {
      'content-security-policy': "default-src 'self'; frame-ancestors 'none'; img-src *",
    };
    applyIframeEmbedHeaders(headers, 'https://parent.example.com');
    const csp = headers['content-security-policy'] as string;
    expect(csp).toContain(`default-src 'self'`);
    expect(csp).toContain('img-src *');
    expect(csp).toContain(`frame-ancestors 'self' https://parent.example.com`);
    // The prior frame-ancestors directive must be gone — otherwise
    // browsers honour the most-restrictive of all directives and the
    // iframe would still be denied.
    expect(csp).not.toContain(`frame-ancestors 'none'`);
  });

  it('creates the CSP header when upstream has none', () => {
    const headers: Record<string, string | string[]> = {};
    applyIframeEmbedHeaders(headers, null);
    expect(headers['content-security-policy']).toBe(`frame-ancestors 'self'`);
  });
});
