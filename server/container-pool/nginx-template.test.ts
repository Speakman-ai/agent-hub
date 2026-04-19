/**
 * nginx-template tests (W2).
 *
 * The renderer is a pure function, so the tests pin the output shape
 * (snapshot-style assertions on critical tokens) + cover validation
 * errors that would produce a broken nginx config.
 */

import { describe, it, expect } from 'vitest';
import { renderPreviewServerBlock, previewConfFilename } from './nginx-template.js';

describe('renderPreviewServerBlock', () => {
  const base = {
    prNumber: 42,
    port: 13042,
    previewHost: 'preview.agenthub.dev',
    certPath: '/etc/letsencrypt/live/preview.agenthub.dev/fullchain.pem',
    keyPath: '/etc/letsencrypt/live/preview.agenthub.dev/privkey.pem',
  };

  it('emits the expected server_name + upstream for PR 42 on port 13042', () => {
    const out = renderPreviewServerBlock(base);
    expect(out).toContain('server_name pr-42.preview.agenthub.dev;');
    expect(out).toContain('proxy_pass http://127.0.0.1:13042;');
  });

  it('includes an HTTP :80 → HTTPS redirect with the ACME challenge carve-out', () => {
    const out = renderPreviewServerBlock(base);
    expect(out).toMatch(/listen 80;[\s\S]*\.well-known\/acme-challenge/);
    expect(out).toContain('return 301 https://$host$request_uri;');
  });

  it('pins TLS cert + key paths into ssl_certificate directives', () => {
    const out = renderPreviewServerBlock(base);
    expect(out).toContain(`ssl_certificate     ${base.certPath};`);
    expect(out).toContain(`ssl_certificate_key ${base.keyPath};`);
  });

  it('threads the WebSocket upgrade headers so preview containers can serve WS', () => {
    const out = renderPreviewServerBlock(base);
    expect(out).toContain('proxy_set_header Upgrade           $http_upgrade;');
    expect(out).toContain('proxy_set_header Connection        $connection_upgrade;');
  });

  it('documents the $connection_upgrade map prerequisite in the header comment', () => {
    const out = renderPreviewServerBlock(base);
    expect(out).toContain('PREREQUISITE');
    expect(out).toContain('$connection_upgrade');
  });

  it('does NOT emit HSTS (parent config handles it at the apex)', () => {
    const out = renderPreviewServerBlock(base);
    expect(out).not.toContain('Strict-Transport-Security');
  });

  it('is deterministic — same input yields byte-identical output (idempotency precondition)', () => {
    const a = renderPreviewServerBlock(base);
    const b = renderPreviewServerBlock(base);
    expect(a).toBe(b);
  });

  it('rejects an invalid port', () => {
    expect(() => renderPreviewServerBlock({ ...base, port: 0 })).toThrow(/invalid input/);
    expect(() => renderPreviewServerBlock({ ...base, port: 70000 })).toThrow(/invalid input/);
  });

  it('rejects a non-absolute cert path', () => {
    expect(() => renderPreviewServerBlock({ ...base, certPath: 'relative/path.pem' })).toThrow(
      /invalid input/,
    );
  });

  it('rejects a previewHost that already includes the pr-<n>. prefix', () => {
    expect(() =>
      renderPreviewServerBlock({ ...base, previewHost: 'pr-42.preview.agenthub.dev' }),
    ).toThrow(/must be the base wildcard host/);
  });

  it('rejects a non-integer PR number', () => {
    expect(() => renderPreviewServerBlock({ ...base, prNumber: 1.5 })).toThrow(/invalid input/);
  });
});

describe('previewConfFilename', () => {
  it('returns a stable filename for a given PR number', () => {
    expect(previewConfFilename(42)).toBe('pr-42.preview.conf');
    expect(previewConfFilename(1)).toBe('pr-1.preview.conf');
  });
});
