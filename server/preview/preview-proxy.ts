/**
 * Same-origin reverse proxy for session previews (prod / remote browsers).
 *
 * Browsers load `/api/sessions/:sessionId/preview/proxy/...` on the Hub
 * origin; the server forwards to `AGENT_HUB_PREVIEW_HEALTH_HOST:<port>`.
 * WebSocket upgrades (Vite HMR, Angular live reload) are tunneled on the
 * same path prefix.
 */
import http from 'node:http';
import type { Server } from 'node:http';
import net from 'node:net';
import type { Duplex } from 'node:stream';
import type { IncomingMessage } from 'node:http';
import type { Request, Response, RequestHandler } from 'express';
import { authenticateWsDetailed } from '../auth.js';
import type { AuthenticatedRequest } from '../auth.js';
import { userOwnsSession as defaultUserOwnsSession } from '../session-ownership.js';
import { parsePreviewSubdomainHost } from './preview-subdomain-host.js';
import {
  devServerPortProxyPath,
  previewProxyMountPath,
  previewSubdomainRewrittenUrl,
  previewUpstreamPathForMount,
  resolvePreviewUpstreamHost,
} from './preview-public-url.js';

export type PreviewProxyDeps = {
  /**
   * Resolve the loopback upstream port for a session. `internalPort` is
   * passed for the dev-server `/preview/proxy/p/<internalPort>` sub-mount
   * so the request reaches that mapped extra port rather than the primary.
   */
  getSessionPreviewPort: (sessionId: string, internalPort?: number) => number | null;
  /**
   * Upstream host for a session, when it is not the Hub-wide default.
   * A container env under container-IP routing answers on its own bridge
   * address rather than loopback; returning null keeps the default.
   */
  getSessionPreviewHost?: (sessionId: string) => string | null;
  userOwnsSession: (req: AuthenticatedRequest, sessionId: string) => boolean;
  /**
   * Public URL of the Hub UI that's expected to iframe the preview
   * (e.g. `https://agenthub.dev.example.com`). Injected into
   * the CSP `frame-ancestors` directive on proxy responses so a
   * cross-origin iframe load (subdomain mode) succeeds while
   * unrelated origins are still refused. `null`/missing falls back
   * to `frame-ancestors 'self'`, which works for the same-origin
   * path-prefix deployment.
   */
  parentPublicUrl?: string | null;
};

const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailers',
  'transfer-encoding',
]);

const PREVIEW_PROXY_PATH_RE = /^\/api\/sessions\/([^/]+)\/preview\/proxy(?:\/(.*))?(?:\?.*)?$/;
const PREVIEW_PROXY_SUBPORT_RE = /^\/api\/sessions\/[^/]+\/preview\/proxy\/p\/(\d+)(?:\/.*)?$/;

/** Parse session id from a preview proxy HTTP or WS URL. */
export function parsePreviewProxySessionId(rawUrl: string | undefined): string | null {
  if (!rawUrl) return null;
  const pathOnly = rawUrl.split('?')[0] ?? '';
  const m = pathOnly.match(PREVIEW_PROXY_PATH_RE);
  if (!m?.[1]) return null;
  try {
    return decodeURIComponent(m[1]);
  } catch {
    return null;
  }
}

/**
 * Parse the internal port from a dev-server extra-port sub-mount
 * (`/api/sessions/:sid/preview/proxy/p/<internalPort>/...`). Returns null
 * for the primary mount (no `/p/` segment) or an out-of-range port — the
 * caller then treats the request as targeting the primary upstream.
 */
export function parsePreviewProxyInternalPort(rawUrl: string | undefined): number | null {
  if (!rawUrl) return null;
  const pathOnly = rawUrl.split('?')[0] ?? '';
  const m = pathOnly.match(PREVIEW_PROXY_SUBPORT_RE);
  if (!m?.[1]) return null;
  const port = Number(m[1]);
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : null;
}

function copyHeaders(src: IncomingMessage): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [key, value] of Object.entries(src.headers)) {
    if (value === undefined) continue;
    if (HOP_BY_HOP.has(key.toLowerCase())) continue;
    out[key] = value;
  }
  return out;
}

/**
 * Inject `<base href>` so SPA asset URLs resolve under the proxy mount.
 *
 * If the upstream HTML already has a `<base>` tag (Angular/Vite/CRA all
 * emit `<base href="/">` by default), we REPLACE it. Leaving the upstream
 * `<base href="/">` would make every relative asset (`main.js`,
 * `styles.css`, `manifest.webmanifest`) resolve at the Hub root instead
 * of the proxy mount; the browser then receives the Hub SPA fallback
 * HTML in place of each asset and the preview iframe goes white with
 * "Manifest: Line 1, column 1, Syntax error" in the console.
 *
 * Bodies that are not HTML *documents* are returned byte-identical.
 * `content-type: text/html` is not a promise of a document: Survey
 * Tracker's `/health` answers `text/html` with the body `OK`, and an
 * unconditionally-compressing upstream delivers a document as binary.
 * Prepending a tag to either corrupts the response, and now that API
 * traffic flows through the `/p/<port>` sub-mount those bodies are
 * routine rather than hypothetical.
 */
export function injectHtmlPreviewBaseHref(
  html: string,
  sessionId: string,
  internalPort?: number,
): string {
  const mount =
    internalPort === undefined
      ? previewProxyMountPath(sessionId)
      : devServerPortProxyPath(sessionId, internalPort, false);
  const baseHref = `${mount}/`;
  const baseTag = `<base href="${baseHref}">`;
  if (/<base\b[^>]*>/i.test(html)) {
    return html.replace(/<base\b[^>]*>/i, baseTag);
  }
  if (/<head[\s>]/i.test(html)) {
    return html.replace(/<head([^>]*)>/i, `<head$1>${baseTag}`);
  }
  // A document may omit `<head>` entirely (it is an optional tag). The parser
  // opens an implied head, so a `<base>` placed directly after `<html>` still
  // lands there and asset resolution is fixed as intended.
  if (/<html[\s>]/i.test(html)) {
    return html.replace(/<html([^>]*)>/i, `<html$1>${baseTag}`);
  }
  return html;
}

/**
 * Should this upstream response body be buffered and rewritten?
 *
 * Only an HTML content type qualifies, and only when the body is not
 * compressed — `injectHtmlPreviewBaseHref` edits text, and editing a gzip
 * stream as text corrupts it. Whether the body is really a *document* is
 * decided later by the injector, which leaves non-documents untouched.
 */
export function shouldRewriteHtmlResponse(
  contentType: string | string[] | undefined,
  contentEncoding: string | string[] | undefined,
): boolean {
  if (!String(contentType ?? '').includes('text/html')) return false;
  const encoding = String(contentEncoding ?? '')
    .trim()
    .toLowerCase();
  return encoding === '' || encoding === 'identity';
}

export function upstreamRequestHeaders(
  req: IncomingMessage,
  host: string,
  port: number,
): Record<string, string | string[]> {
  const headers = copyHeaders(req);
  headers.host = `${host}:${port}`;
  // Ask the upstream for an identity encoding. We rewrite `<base href>` into
  // HTML documents, which requires reading the body as text — a gzipped body
  // would be edited as binary garbage. The upstream is a dev server one hop
  // away over a container-local network, so giving up wire compression on that
  // hop costs nothing; the Hub still compresses its own response to the client.
  delete headers['accept-encoding'];
  return headers;
}

/**
 * Compute the `Content-Security-Policy: frame-ancestors` value that
 * lets the Hub UI iframe the preview. `'self'` covers the path-prefix
 * deployment (parent and iframe share an origin); when subdomain mode
 * is on, the parent (Hub UI) and iframe (`<sid>.preview.<base>`) are
 * different origins, so the parent origin must be listed explicitly
 * via the configured `AGENT_HUB_PUBLIC_URL`.
 *
 * Returned value is suitable for `res.setHeader('Content-Security-Policy', ...)`.
 * Frame-ancestors is the modern replacement for `X-Frame-Options`; per
 * spec the latter is ignored when CSP frame-ancestors is present, so
 * we also strip any upstream-set XFO to avoid clients honouring an
 * upstream `DENY`/`SAMEORIGIN` ahead of our explicit allowlist.
 */
export function buildFrameAncestorsCsp(parentPublicUrl: string | null | undefined): string {
  const sources = ["'self'"];
  if (parentPublicUrl) {
    try {
      const u = new URL(parentPublicUrl);
      // Use the origin (scheme + host + port) — CSP doesn't honour
      // paths in frame-ancestors anyway.
      const origin = `${u.protocol}//${u.host}`;
      if (!sources.includes(origin)) sources.push(origin);
    } catch {
      // Bad publicUrl — fail closed; same-origin only.
    }
  }
  return `frame-ancestors ${sources.join(' ')}`;
}

export function applyIframeEmbedHeaders(
  responseHeaders: Record<string, string | string[]>,
  parentPublicUrl: string | null | undefined,
): void {
  // Drop any upstream X-Frame-Options so it doesn't take precedence
  // over our CSP frame-ancestors on older browsers that honour XFO
  // even when CSP is present (Safari has historically been lax here).
  delete responseHeaders['x-frame-options'];
  delete responseHeaders['X-Frame-Options'];
  // Merge into any existing CSP rather than clobber — upstream may
  // set other directives we want to preserve. If no upstream CSP,
  // create one. Header names are normalised to lowercase by node http.
  const existing = responseHeaders['content-security-policy'];
  const ancestors = buildFrameAncestorsCsp(parentPublicUrl);
  if (typeof existing === 'string' && existing.length > 0) {
    // Strip any existing frame-ancestors directive — ours wins.
    const trimmed = existing
      .split(';')
      .map((d) => d.trim())
      .filter((d) => d && !/^frame-ancestors\b/i.test(d))
      .join('; ');
    responseHeaders['content-security-policy'] = trimmed ? `${trimmed}; ${ancestors}` : ancestors;
  } else {
    responseHeaders['content-security-policy'] = ancestors;
  }
}

function proxyHttp(
  req: Request,
  res: Response,
  sessionId: string,
  port: number,
  parentPublicUrl?: string | null,
  internalPort?: number,
  upstreamHost: string = resolvePreviewUpstreamHost(),
): void {
  const mount =
    internalPort === undefined
      ? previewProxyMountPath(sessionId)
      : devServerPortProxyPath(sessionId, internalPort, false);
  const path = previewUpstreamPathForMount(req.originalUrl, mount);
  const headers = upstreamRequestHeaders(req, upstreamHost, port);

  const proxyReq = http.request(
    {
      hostname: upstreamHost,
      port,
      path,
      method: req.method,
      headers,
    },
    (proxyRes) => {
      const responseHeaders = copyHeaders(proxyRes);
      const shouldRewriteHtml = shouldRewriteHtmlResponse(
        proxyRes.headers['content-type'],
        proxyRes.headers['content-encoding'],
      );

      // CSP frame-ancestors so the iframe is embeddable by the Hub UI.
      // Applied to ALL response types (HTML, JS, CSS, images) so the
      // browser sees the policy on every sub-resource fetch — frame-
      // ancestors only matters on the document, but setting it
      // uniformly is cheap and avoids surprising behaviour if some
      // upstream type ever becomes the iframe document.
      applyIframeEmbedHeaders(responseHeaders, parentPublicUrl);

      if (!shouldRewriteHtml) {
        if (!res.headersSent) {
          res.writeHead(proxyRes.statusCode ?? 502, responseHeaders);
        }
        proxyRes.pipe(res);
        return;
      }

      const chunks: Buffer[] = [];
      proxyRes.on('data', (chunk: Buffer) => chunks.push(chunk));
      proxyRes.on('end', () => {
        const original = Buffer.concat(chunks);
        const text = original.toString('utf8');
        const rewritten = injectHtmlPreviewBaseHref(text, sessionId, internalPort);
        // On a no-op, forward the original bytes rather than the re-encoded
        // string: a body in any non-UTF-8 charset would not survive the
        // round-trip, and a non-document has no reason to be touched at all.
        const body = rewritten === text ? original : Buffer.from(rewritten, 'utf8');
        delete responseHeaders['content-length'];
        responseHeaders['content-length'] = String(body.length);
        if (!res.headersSent) {
          res.writeHead(proxyRes.statusCode ?? 502, responseHeaders);
        }
        res.end(body);
      });
    },
  );

  proxyReq.on('error', (err) => {
    if (!res.headersSent) {
      res.statusCode = 502;
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.end(`Preview proxy error: ${err.message}`);
      return;
    }
    res.end();
  });

  // Express's body-parsing middleware (express.json / express.urlencoded)
  // consumes the raw request stream before this handler runs. For GET/HEAD
  // (no body) req.pipe() works because there's nothing to pipe. For POST/
  // PUT/PATCH with a body, the raw stream is already drained — pipe() writes
  // nothing, the upstream waits for the body forever, and the request hangs.
  //
  // When req.body is populated (body was parsed), serialise it back and
  // write it explicitly. When req.body is absent (no body parser matched,
  // e.g. multipart or unknown content-type), fall back to pipe — the raw
  // stream is still intact in that case.
  if (
    req.body !== undefined &&
    req.body !== null &&
    req.method !== 'GET' &&
    req.method !== 'HEAD'
  ) {
    const bodyStr = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
    const bodyBytes = Buffer.byteLength(bodyStr);
    delete headers['transfer-encoding'];
    delete headers['Transfer-Encoding'];
    if (typeof req.body === 'string') {
      const contentType = req.headers['content-type'];
      if (contentType !== undefined) {
        headers['content-type'] = contentType;
      }
    } else {
      headers['content-type'] = 'application/json';
    }
    headers['content-length'] = String(bodyBytes);
    proxyReq.setHeader('content-length', String(bodyBytes));
    if (headers['content-type']) {
      proxyReq.setHeader('content-type', headers['content-type'] as string);
    }
    proxyReq.end(bodyStr);
  } else {
    req.pipe(proxyReq);
  }
}

function denyUpgrade(socket: Duplex, statusLine: string): void {
  socket.write(`${statusLine}\r\n\r\n`);
  socket.destroy();
}

function buildUpgradeRequestLines(
  req: IncomingMessage,
  path: string,
  upstreamHost: string,
  port: number,
): string {
  const lines = [`${req.method ?? 'GET'} ${path} HTTP/${req.httpVersion || '1.1'}`];
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    const lower = key.toLowerCase();
    if (lower === 'host') continue;
    if (Array.isArray(value)) {
      for (const v of value) lines.push(`${key}: ${v}`);
    } else {
      lines.push(`${key}: ${value}`);
    }
  }
  lines.push(`Host: ${upstreamHost}:${port}`);
  lines.push('Connection: Upgrade');
  lines.push('');
  return `${lines.join('\r\n')}\r\n`;
}

/** Tunnel a WebSocket upgrade to the session preview dev server. */
export function handlePreviewProxyUpgrade(
  req: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  deps: PreviewProxyDeps,
): void {
  const sessionId = parsePreviewProxySessionId(req.url);
  if (!sessionId) return;

  const auth = authenticateWsDetailed(req);
  const ownerReq = { authUserId: auth.userId } as AuthenticatedRequest;
  if (!auth.ok || !deps.userOwnsSession(ownerReq, sessionId)) {
    denyUpgrade(socket, 'HTTP/1.1 403 Forbidden');
    return;
  }

  const internalPort = parsePreviewProxyInternalPort(req.url);
  const port = deps.getSessionPreviewPort(sessionId, internalPort ?? undefined);
  if (port == null) {
    denyUpgrade(socket, 'HTTP/1.1 503 Service Unavailable');
    return;
  }

  const upstreamHost = deps.getSessionPreviewHost?.(sessionId) ?? resolvePreviewUpstreamHost();
  const mount =
    internalPort == null
      ? previewProxyMountPath(sessionId)
      : devServerPortProxyPath(sessionId, internalPort, false);
  const path = previewUpstreamPathForMount(req.url, mount);

  const proxySocket = net.connect({ host: upstreamHost, port }, () => {
    proxySocket.write(buildUpgradeRequestLines(req, path, upstreamHost, port));
    if (head.length > 0) proxySocket.write(head);
    socket.pipe(proxySocket);
    proxySocket.pipe(socket);
  });

  proxySocket.on('error', () => {
    if (!socket.destroyed) socket.destroy();
  });
  socket.on('error', () => {
    if (!proxySocket.destroyed) proxySocket.destroy();
  });
}

/**
 * Handle preview-proxy WebSocket upgrades before the Hub chat `ws` server.
 * Non-matching URLs are left for other upgrade listeners.
 *
 * In subdomain mode, the upgrade arrives at `wss://<sid>.<base>/...`
 * with NO path prefix on `req.url` — dev-server HMR sockets just hit
 * `/` or `/_vite/ws` etc. To keep `handlePreviewProxyUpgrade` working
 * unchanged (it parses the session id off `req.url` via the path
 * prefix), we rewrite `req.url` here when the Host matches the
 * configured subdomain base, mirroring the HTTP middleware in
 * `server/index.ts`.
 */
export function attachPreviewProxyUpgrade(
  server: Server,
  deps: PreviewProxyDeps,
  opts?: { subdomainBase?: string | null },
): void {
  server.prependListener('upgrade', (req, socket, head) => {
    // Subdomain dispatch — only fires when `opts.subdomainBase` is set
    // AND the Host matches `<uuid>.<base>`. Mirrors the HTTP middleware
    // in server/index.ts (same parser, same rewrite shape) so the WS
    // and HTTP code paths can't drift.
    const base = opts?.subdomainBase ?? null;
    if (base) {
      const target = parsePreviewSubdomainHost(req.headers.host, base);
      if (target && !parsePreviewProxySessionId(req.url)) {
        req.url = previewSubdomainRewrittenUrl(target, req.url);
      }
    }
    if (!parsePreviewProxySessionId(req.url)) return;
    handlePreviewProxyUpgrade(req, socket, head, deps);
  });
}

export function createPreviewProxyHandler(deps: PreviewProxyDeps): RequestHandler {
  return (req: Request, res: Response) => {
    const sessionId = req.params.sessionId as string;
    if (!sessionId) {
      res.status(400).send('sessionId required');
      return;
    }
    const authed = req as AuthenticatedRequest;
    if (!authed.authPreviewManifestBypass && !deps.userOwnsSession(authed, sessionId)) {
      res.status(404).send('Session not found');
      return;
    }
    const internalPort = parsePreviewProxyInternalPort(req.originalUrl);
    const port = deps.getSessionPreviewPort(sessionId, internalPort ?? undefined);
    if (port == null) {
      res.status(503).send('No active preview for this session');
      return;
    }
    proxyHttp(
      req,
      res,
      sessionId,
      port,
      deps.parentPublicUrl,
      internalPort ?? undefined,
      deps.getSessionPreviewHost?.(sessionId) ?? resolvePreviewUpstreamHost(),
    );
  };
}

/** Default wiring for `index.ts` — same port lookup as the HTTP proxy routes. */
export function attachDefaultPreviewProxyUpgrade(
  server: Server,
  lookup: Pick<PreviewProxyDeps, 'getSessionPreviewPort' | 'getSessionPreviewHost'>,
  opts?: { subdomainBase?: string | null },
): void {
  attachPreviewProxyUpgrade(
    server,
    {
      getSessionPreviewPort: lookup.getSessionPreviewPort,
      ...(lookup.getSessionPreviewHost
        ? { getSessionPreviewHost: lookup.getSessionPreviewHost }
        : {}),
      userOwnsSession: defaultUserOwnsSession,
    },
    opts,
  );
}
