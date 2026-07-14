/**
 * ops/nginx/agent-hub.conf — structural assertions.
 *
 * The nginx config is a static text file that runs at the edge in prod, so
 * we can't exercise it via the Express app. These tests pin the headers and
 * location blocks we care about so a careless edit (e.g. putting
 * `X-Frame-Options: DENY` back on `/design-files/`) trips CI instead of
 * surfacing in production as `ERR_BLOCKED_BY_RESPONSE` on the Design canvas.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const CONF_PATH = resolve(__dirname, '..', 'ops', 'nginx', 'agent-hub.conf');
const CONF = readFileSync(CONF_PATH, 'utf8');
const CLIENT_CONF_PATH = resolve(__dirname, '..', 'client', 'nginx.conf');
const CLIENT_CONF = readFileSync(CLIENT_CONF_PATH, 'utf8');

/**
 * Extract a `location <prefix>` { ... } block by matching brace pairs.
 * Returns the inner body (without the outer braces), or `null` if no such
 * block exists.
 */
function extractLocation(prefix: string, conf = CONF): string | null {
  // Find `location <prefix>` with any nginx location modifier, then find the
  // matching closing brace by counting depth. Literal string matching also
  // handles regex location expressions without parsing their syntax.
  const matches = [
    `location ${prefix} {`,
    `location = ${prefix} {`,
    `location ^~ ${prefix} {`,
    `location ~ ${prefix} {`,
    `location ~* ${prefix} {`,
  ]
    .map((header) => ({ header, index: conf.indexOf(header) }))
    .filter((match) => match.index >= 0)
    .sort((a, b) => a.index - b.index);
  const match = matches[0];
  if (!match) return null;
  let depth = 1;
  const start = match.index + match.header.length;
  for (let i = start; i < conf.length; i++) {
    if (conf[i] === '{') depth++;
    else if (conf[i] === '}') {
      depth--;
      if (depth === 0) return conf.slice(start, i);
    }
  }
  return null;
}

describe('ops/nginx/agent-hub.conf', () => {
  it('defines the /design-files/ location', () => {
    expect(extractLocation('/design-files/')).not.toBeNull();
  });

  it('omits X-Frame-Options on /design-files/ so the hub iframe can load', () => {
    const body = extractLocation('/design-files/');
    expect(body).not.toBeNull();
    // The comment above the block mentions X-Frame-Options to explain the
    // omission, so we assert on an `add_header` directive specifically rather
    // than the raw string. An edit that adds `add_header X-Frame-Options ...`
    // back into this location will fail this test.
    expect(body!).not.toMatch(/add_header\s+X-Frame-Options/i);
  });

  it('retains the other hardening headers on /design-files/ (nginx add_header does NOT inherit once overridden)', () => {
    const body = extractLocation('/design-files/');
    expect(body).not.toBeNull();
    expect(body!).toMatch(/add_header\s+Strict-Transport-Security/);
    expect(body!).toMatch(/add_header\s+X-Content-Type-Options\s+"nosniff"/);
    expect(body!).toMatch(/add_header\s+Referrer-Policy/);
  });

  it('proxies /design-files/ to the Express upstream on 3051', () => {
    const body = extractLocation('/design-files/');
    expect(body).not.toBeNull();
    expect(body!).toMatch(/proxy_pass\s+http:\/\/127\.0\.0\.1:3051/);
  });

  it('still applies X-Frame-Options: DENY at the server level for everything that does not override', () => {
    // The server-level header remains the default for SPA + API + WS + /uploads/.
    // Only /design-files/ opts out (by declaring its own add_header set).
    expect(CONF).toMatch(/add_header\s+X-Frame-Options\s+"DENY"\s+always;/);
  });

  describe('/git/ smart-HTTP location (Agent Hub-hosted repos)', () => {
    it('defines the /git/ location proxying to the Express upstream', () => {
      const body = extractLocation('/git/');
      expect(body).not.toBeNull();
      expect(body!).toMatch(/proxy_pass\s+http:\/\/127\.0\.0\.1:3051/);
    });

    it('streams both directions: request and response buffering off, HTTP/1.1 upstream', () => {
      const body = extractLocation('/git/')!;
      // receive-pack reads bodies incrementally; buffering a multi-GB push
      // to disk first would stall it (and clones would buffer in nginx).
      expect(body).toMatch(/proxy_request_buffering\s+off;/);
      expect(body).toMatch(/proxy_buffering\s+off;/);
      // Required when request buffering is off.
      expect(body).toMatch(/proxy_http_version\s+1\.1;/);
    });

    it('removes the body-size cap and extends timeouts for large pushes/clones', () => {
      const body = extractLocation('/git/')!;
      expect(body).toMatch(/client_max_body_size\s+0;/);
      expect(body).toMatch(/proxy_read_timeout\s+3600s;/);
      expect(body).toMatch(/proxy_send_timeout\s+3600s;/);
    });
  });

  describe('dedicated terminal WebSocket location', () => {
    const terminalLocation = '^/api/sessions/[^/]+/terminal/ws/?$';

    it.each([
      ['self-hosted edge', CONF],
      ['container client', CLIENT_CONF],
    ])('%s preserves WebSocket upgrades before the generic /api proxy', (_label, conf) => {
      const body = extractLocation(terminalLocation, conf);
      expect(body).not.toBeNull();
      expect(body!).toMatch(/proxy_http_version\s+1\.1;/);
      expect(body!).toMatch(/proxy_set_header\s+Upgrade\s+\$http_upgrade;/);
      expect(body!).toMatch(/proxy_set_header\s+Connection\s+\$connection_upgrade;/);
      expect(body!).toMatch(/proxy_read_timeout\s+86400s;/);
    });

    it('uses sanitized logging at the self-hosted edge so auth query strings are not stored', () => {
      const body = extractLocation(terminalLocation, CONF);
      expect(body).toMatch(/access_log\s+\S+\s+ws_sanitized;/);
    });
  });
});
