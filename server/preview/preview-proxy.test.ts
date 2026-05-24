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

  it('does not duplicate an existing base tag', () => {
    const html = '<html><head><base href="/"></head></html>';
    expect(injectHtmlPreviewBaseHref(html, 'sess-1')).toBe(html);
  });
});
