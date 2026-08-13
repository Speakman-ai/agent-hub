import http from 'node:http';
import type { IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { gunzipSync, gzipSync } from 'node:zlib';
import express from 'express';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, it, expect } from 'vitest';
import {
  applyIframeEmbedHeaders,
  buildFrameAncestorsCsp,
  createPreviewProxyHandler,
  injectHtmlPreviewBaseHref,
  parsePreviewProxyInternalPort,
  parsePreviewProxySessionId,
  shouldRewriteHtmlResponse,
  upstreamRequestHeaders,
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

describe('parsePreviewProxyInternalPort', () => {
  it('extracts the internal port from a /p/<port> sub-mount', () => {
    expect(parsePreviewProxyInternalPort('/api/sessions/abc/preview/proxy/p/8787')).toBe(8787);
    expect(parsePreviewProxyInternalPort('/api/sessions/abc/preview/proxy/p/8787/foo/bar')).toBe(
      8787,
    );
    expect(parsePreviewProxyInternalPort('/api/sessions/abc/preview/proxy/p/8787/ws?token=x')).toBe(
      8787,
    );
  });

  it('returns null for the primary mount and out-of-range ports', () => {
    expect(parsePreviewProxyInternalPort('/api/sessions/abc/preview/proxy')).toBeNull();
    expect(parsePreviewProxyInternalPort('/api/sessions/abc/preview/proxy/main.js')).toBeNull();
    // A path segment literally named "p" but not the sub-mount shape.
    expect(parsePreviewProxyInternalPort('/api/sessions/abc/preview/proxy/p/notaport')).toBeNull();
    expect(parsePreviewProxyInternalPort('/api/sessions/abc/preview/proxy/p/0')).toBeNull();
    expect(parsePreviewProxyInternalPort('/api/sessions/abc/preview/proxy/p/99999')).toBeNull();
    expect(parsePreviewProxyInternalPort(undefined)).toBeNull();
  });
});

describe('upstreamRequestHeaders', () => {
  function fakeReq(headers: Record<string, string>): IncomingMessage {
    return { headers } as unknown as IncomingMessage;
  }

  it('points Host at the upstream the request is dialed to', () => {
    const out = upstreamRequestHeaders(fakeReq({ host: 'example.test' }), '172.17.0.4', 8000);
    expect(out.host).toBe('172.17.0.4:8000');
  });

  // We read HTML bodies as text to inject <base href>; a gzipped body would be
  // edited as binary. Asking upstream for identity keeps the rewrite sound, and
  // the upstream is one container-local hop away so compression buys nothing.
  it('drops accept-encoding so bodies we may rewrite arrive uncompressed', () => {
    const out = upstreamRequestHeaders(
      fakeReq({ host: 'example.test', 'accept-encoding': 'gzip, br' }),
      '127.0.0.1',
      4200,
    );
    expect(out['accept-encoding']).toBeUndefined();
  });

  it('forwards other request headers untouched', () => {
    const out = upstreamRequestHeaders(
      fakeReq({ host: 'example.test', 'x-custom': 'v', cookie: 'a=b' }),
      '127.0.0.1',
      4200,
    );
    expect(out['x-custom']).toBe('v');
    expect(out.cookie).toBe('a=b');
  });
});

describe('shouldRewriteHtmlResponse', () => {
  it('rewrites uncompressed HTML', () => {
    expect(shouldRewriteHtmlResponse('text/html; charset=utf-8', undefined)).toBe(true);
    expect(shouldRewriteHtmlResponse('text/html', 'identity')).toBe(true);
  });

  it('never rewrites non-HTML', () => {
    expect(shouldRewriteHtmlResponse('application/json', undefined)).toBe(false);
    expect(shouldRewriteHtmlResponse(undefined, undefined)).toBe(false);
  });

  // Belt-and-braces for an upstream that compresses regardless of
  // accept-encoding: stream it through rather than corrupt it.
  it('never rewrites a compressed body', () => {
    expect(shouldRewriteHtmlResponse('text/html', 'gzip')).toBe(false);
    expect(shouldRewriteHtmlResponse('text/html', 'br')).toBe(false);
    expect(shouldRewriteHtmlResponse('text/html', 'GZIP')).toBe(false);
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

  // Regression: the old fallback prepended the tag to ANY body served as
  // text/html. Survey Tracker's /health answers text/html with the body "OK",
  // so the proxy turned it into `<base href="...">OK`. Now that API traffic
  // reaches the backend through the /p/<port> sub-mount, non-document bodies
  // with an HTML content type are routine.
  it('leaves a non-document text/html body byte-identical', () => {
    expect(injectHtmlPreviewBaseHref('OK', 'sess-1')).toBe('OK');
    expect(injectHtmlPreviewBaseHref('{"detail":"ok"}', 'sess-1')).toBe('{"detail":"ok"}');
    expect(injectHtmlPreviewBaseHref('', 'sess-1')).toBe('');
  });

  // A gzipped document read as text matches none of the document patterns, so
  // it must fall through untouched rather than gain a prepended tag.
  it('does not prepend a tag to a body it cannot recognise as a document', () => {
    const binaryish = '\u001f\u008b\u0008\u0000garbage';
    expect(injectHtmlPreviewBaseHref(binaryish, 'sess-1')).toBe(binaryish);
  });

  it('injects into a document that omits the optional <head> tag', () => {
    const html = '<html><body><p>hi</p></body></html>';
    const out = injectHtmlPreviewBaseHref(html, 'sess-1');
    expect(out).toContain('<base href="/api/sessions/sess-1/preview/proxy/">');
    // Must land inside the implied head, i.e. before any body content.
    expect(out.indexOf('<base')).toBeLessThan(out.indexOf('<body'));
  });

  it('points the base href at the /p/<internalPort> sub-mount for extra ports', () => {
    const html = '<html><head><base href="/"></head></html>';
    const out = injectHtmlPreviewBaseHref(html, 'sess-1', 8787);
    expect(out).toContain('<base href="/api/sessions/sess-1/preview/proxy/p/8787/">');
    expect(out).not.toContain('href="/"');
  });
});

describe('preview proxy routing (end-to-end)', () => {
  const upstreams: http.Server[] = [];
  // The proxy dials `resolvePreviewUpstreamHost()`, which honors
  // AGENT_HUB_PREVIEW_HEALTH_HOST (set to the docker bridge IP in some CI
  // envs). Pin it to loopback so the fake upstreams (bound to 127.0.0.1)
  // are reachable regardless of the host's ambient value.
  const priorHealthHost = process.env.AGENT_HUB_PREVIEW_HEALTH_HOST;
  beforeAll(() => {
    process.env.AGENT_HUB_PREVIEW_HEALTH_HOST = '127.0.0.1';
  });
  afterAll(() => {
    if (priorHealthHost === undefined) delete process.env.AGENT_HUB_PREVIEW_HEALTH_HOST;
    else process.env.AGENT_HUB_PREVIEW_HEALTH_HOST = priorHealthHost;
  });

  afterEach(async () => {
    await Promise.all(upstreams.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))));
  });

  /** Loopback upstream that echoes the exact path/method it received. */
  async function startUpstream(tag: string): Promise<number> {
    const server = http.createServer((req, res) => {
      res.setHeader('content-type', 'text/plain');
      res.end(`${tag}:${req.method}:${req.url}`);
    });
    upstreams.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    return (server.address() as AddressInfo).port;
  }

  function appWith(getSessionPreviewPort: (sid: string, internalPort?: number) => number | null) {
    const app = express();
    const handler = createPreviewProxyHandler({
      getSessionPreviewPort,
      userOwnsSession: () => true,
    });
    app.all('/api/sessions/:sessionId/preview/proxy', handler);
    app.all('/api/sessions/:sessionId/preview/proxy/*', handler);
    return app;
  }

  it('routes an extra-port /p/<internalPort> URL to the mapped host port and strips the sub-mount', async () => {
    const primaryPort = await startUpstream('primary');
    const extraPort = await startUpstream('extra');
    // Map internal 8787 → the extra upstream; primary (no internalPort) → the
    // primary upstream. Anything else is unmapped.
    const app = appWith((sid, internalPort) => {
      if (sid !== 'sess-1') return null;
      if (internalPort === 8787) return extraPort;
      if (internalPort === undefined) return primaryPort;
      return null;
    });

    const extra = await request(app).get('/api/sessions/sess-1/preview/proxy/p/8787/foo/bar?x=1');
    expect(extra.status).toBe(200);
    // Reached the EXTRA upstream (not primary) with the /p/8787 segment stripped.
    expect(extra.text).toBe('extra:GET:/foo/bar?x=1');

    const primary = await request(app).get('/api/sessions/sess-1/preview/proxy/assets/app.js');
    expect(primary.status).toBe(200);
    expect(primary.text).toBe('primary:GET:/assets/app.js');
  });

  /** Upstream that answers with a fixed body, content type, and encoding. */
  async function startFixedUpstream(
    body: Buffer | string,
    headers: Record<string, string>,
  ): Promise<number> {
    const server = http.createServer((req, res) => {
      for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
      res.end(body);
    });
    upstreams.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    return (server.address() as AddressInfo).port;
  }

  // Reproduces the observed corruption: Survey Tracker's /health answers
  // `text/html` with the body `OK`, and the proxy returned `<base href="…">OK`.
  it('does not inject into a text/html body that is not a document', async () => {
    const port = await startFixedUpstream('OK', { 'content-type': 'text/html; charset=utf-8' });
    const app = appWith(() => port);
    const res = await request(app).get('/api/sessions/sess-1/preview/proxy/p/8000/health');
    expect(res.status).toBe(200);
    expect(res.text).toBe('OK');
    expect(res.text).not.toContain('<base');
  });

  it('still injects into a real HTML document', async () => {
    const port = await startFixedUpstream('<html><head><title>t</title></head></html>', {
      'content-type': 'text/html',
    });
    const app = appWith(() => port);
    const res = await request(app).get('/api/sessions/sess-1/preview/proxy/');
    expect(res.text).toContain('<base href="/api/sessions/sess-1/preview/proxy/">');
  });

  it('asks the upstream not to compress, so HTML arrives rewritable', async () => {
    let seen: string | undefined = 'unset';
    const server = http.createServer((req, res) => {
      seen = req.headers['accept-encoding'] as string | undefined;
      res.setHeader('content-type', 'text/html');
      res.end('<html><head></head></html>');
    });
    upstreams.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;

    const app = appWith(() => port);
    const res = await request(app)
      .get('/api/sessions/sess-1/preview/proxy/')
      .set('accept-encoding', 'gzip, br');
    expect(seen).toBeUndefined();
    expect(res.text).toContain('<base href=');
  });

  // An upstream that compresses regardless must pass through byte-for-byte
  // rather than have a tag prepended to its gzip stream.
  it('passes a compressed HTML body through untouched', async () => {
    const gzipped = gzipSync(Buffer.from('<html><head></head><body>hi</body></html>'));
    const port = await startFixedUpstream(gzipped, {
      'content-type': 'text/html',
      'content-encoding': 'gzip',
    });
    const app = appWith(() => port);
    const res = await request(app)
      .get('/api/sessions/sess-1/preview/proxy/')
      .responseType('blob')
      .set('accept-encoding', 'identity');
    // supertest/superagent transparently gunzips, so compare the decoded body:
    // the point is that no `<base>` tag was spliced into the gzip stream.
    const received = Buffer.isBuffer(res.body) ? res.body : Buffer.from(String(res.text ?? ''));
    const decoded = received.equals(gzipped)
      ? gunzipSync(received).toString()
      : received.toString();
    expect(decoded).toBe('<html><head></head><body>hi</body></html>');
    expect(decoded).not.toContain('<base');
  });

  it('503s when the requested extra port is not mapped', async () => {
    const primaryPort = await startUpstream('primary');
    const app = appWith((sid, internalPort) =>
      sid === 'sess-1' && internalPort === undefined ? primaryPort : null,
    );
    const res = await request(app).get('/api/sessions/sess-1/preview/proxy/p/9999/');
    expect(res.status).toBe(503);
  });

  it('forwards a parsed JSON POST body with content-length and content-type', async () => {
    let seenLength: string | undefined;
    let seenType: string | undefined;
    let seenBody = '';
    const server = http.createServer((req, res) => {
      seenLength = req.headers['content-length'];
      seenType = req.headers['content-type'];
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        seenBody = Buffer.concat(chunks).toString('utf8');
        res.setHeader('content-type', 'text/plain');
        res.end('ok');
      });
    });
    upstreams.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;

    const app = express();
    app.use(express.json());
    const handler = createPreviewProxyHandler({
      getSessionPreviewPort: () => port,
      userOwnsSession: () => true,
    });
    app.post('/api/sessions/:sessionId/preview/proxy/*', handler);

    const payload = { hello: 'world', n: 3 };
    const res = await request(app)
      .post('/api/sessions/sess-1/preview/proxy/api/save')
      .send(payload);
    expect(res.status).toBe(200);
    expect(seenLength).toBe(String(Buffer.byteLength(JSON.stringify(payload))));
    expect(seenType).toBe('application/json');
    expect(seenBody).toBe(JSON.stringify(payload));
  });

  it('strips transfer-encoding when re-serializing a parsed JSON body', async () => {
    let seenTe: string | string[] | undefined;
    let seenLength: string | undefined;
    const server = http.createServer((req, res) => {
      seenTe = req.headers['transfer-encoding'];
      seenLength = req.headers['content-length'];
      req.resume();
      req.on('end', () => {
        res.setHeader('content-type', 'text/plain');
        res.end('ok');
      });
    });
    upstreams.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;

    const app = express();
    app.use(express.json());
    const handler = createPreviewProxyHandler({
      getSessionPreviewPort: () => port,
      userOwnsSession: () => true,
    });
    app.post('/api/sessions/:sessionId/preview/proxy/*', (req, res, next) => {
      // Simulate a chunked inbound request that Express already parsed.
      req.headers['transfer-encoding'] = 'chunked';
      delete req.headers['content-length'];
      return handler(req, res, next);
    });

    const res = await request(app)
      .post('/api/sessions/sess-1/preview/proxy/api/save')
      .send({ a: 1 });
    expect(res.status).toBe(200);
    expect(seenTe).toBeUndefined();
    expect(seenLength).toBe(String(Buffer.byteLength(JSON.stringify({ a: 1 }))));
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
