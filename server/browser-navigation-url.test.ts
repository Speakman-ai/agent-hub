import { describe, it, expect } from 'vitest';
import { validateBrowserNavigationUrl } from './browser-navigation-url.js';

describe('validateBrowserNavigationUrl', () => {
  it('allows a normal public https URL', () => {
    const r = validateBrowserNavigationUrl('https://example.com/path?q=1');
    expect(r).toEqual({ ok: true, href: 'https://example.com/path?q=1' });
  });

  it('rejects empty and invalid URLs', () => {
    expect(validateBrowserNavigationUrl('').ok).toBe(false);
    expect(validateBrowserNavigationUrl('   ').ok).toBe(false);
    expect(validateBrowserNavigationUrl('not a url').ok).toBe(false);
  });

  it('rejects non-http(s) schemes', () => {
    expect(validateBrowserNavigationUrl('file:///etc/passwd').ok).toBe(false);
    expect(validateBrowserNavigationUrl('javascript:alert(1)').ok).toBe(false);
    expect(validateBrowserNavigationUrl('ftp://example.com/').ok).toBe(false);
  });

  it('rejects URLs with embedded credentials', () => {
    const r = validateBrowserNavigationUrl('https://user:pass@example.com/');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/credentials/i);
  });

  it('rejects localhost', () => {
    expect(validateBrowserNavigationUrl('http://localhost:3051/').ok).toBe(false);
    expect(validateBrowserNavigationUrl('http://app.localhost/').ok).toBe(false);
  });

  it('rejects loopback and private IPv4', () => {
    expect(validateBrowserNavigationUrl('http://127.0.0.1/').ok).toBe(false);
    expect(validateBrowserNavigationUrl('http://10.0.0.5/').ok).toBe(false);
    expect(validateBrowserNavigationUrl('http://192.168.1.1/').ok).toBe(false);
    expect(validateBrowserNavigationUrl('http://172.20.1.1/').ok).toBe(false);
    expect(validateBrowserNavigationUrl('http://169.254.169.254/latest/meta-data/').ok).toBe(false);
    expect(validateBrowserNavigationUrl('http://100.100.1.1/').ok).toBe(false);
    expect(validateBrowserNavigationUrl('http://0.0.0.0/').ok).toBe(false);
  });

  it('rejects cloud metadata hostname', () => {
    expect(validateBrowserNavigationUrl('http://metadata.google.internal/').ok).toBe(false);
  });

  it('rejects decimal / hex integer hosts that URL.parse normalizes to loopback', () => {
    expect(validateBrowserNavigationUrl('http://2130706433/').ok).toBe(false);
    expect(validateBrowserNavigationUrl('http://0x7f000001/').ok).toBe(false);
  });

  it('rejects blocked IPv6', () => {
    expect(validateBrowserNavigationUrl('http://[::1]/').ok).toBe(false);
    expect(validateBrowserNavigationUrl('http://[fe80::1]/').ok).toBe(false);
    expect(validateBrowserNavigationUrl('http://[::ffff:127.0.0.1]/').ok).toBe(false);
  });
});
