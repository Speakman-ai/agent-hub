import { describe, it, expect } from 'vitest';
import { injectBaseHref } from './DesignView.jsx';

/**
 * injectBaseHref — pure HTML-mangling helper used to rewrite design-files
 * HTML before feeding it into the iframe's `srcdoc`. Relative asset paths
 * (CSS/JS/images) inside an `about:srcdoc` document would otherwise fail
 * to resolve — the injected `<base href>` points them back at the server.
 */
describe('injectBaseHref', () => {
  const href = 'http://localhost:3051/design-files/d-1/';

  it('inserts <base> immediately after <head> when no existing base', () => {
    const html = '<html><head><title>X</title></head><body>hi</body></html>';
    const out = injectBaseHref(html, href);
    expect(out).toContain(`<head><base href="${href}"><title>X</title>`);
  });

  it('replaces an existing <base> tag', () => {
    const html = '<html><head><base href="/old/"><title>X</title></head><body/></html>';
    const out = injectBaseHref(html, href);
    expect(out).toContain(`<base href="${href}">`);
    expect(out).not.toContain('<base href="/old/">');
    // Only one base tag
    expect(out.match(/<base\b/gi)?.length).toBe(1);
  });

  it('prepends <base> when no <head> is present', () => {
    const html = '<div>just a fragment</div>';
    const out = injectBaseHref(html, href);
    expect(out.startsWith(`<base href="${href}">`)).toBe(true);
    expect(out).toContain('<div>just a fragment</div>');
  });

  it('HTML-escapes " in the href value to prevent attribute injection', () => {
    const evil = 'http://example.com/"onerror=alert(1) x="';
    const out = injectBaseHref('<html><head></head></html>', evil);
    // Raw unescaped double-quote from the payload must not reach the attribute
    // (that's the only thing that could "break out" of the href="…" wrapper).
    expect(out).toContain('&quot;onerror=alert(1)');
    // The surrounding quotes of the attribute are preserved, and no literal
    // `"` from the evil payload survives inside the attribute value
    expect(out).toMatch(/<base href="[^"]*&quot;onerror=alert\(1\)[^"]*">/);
  });
});
