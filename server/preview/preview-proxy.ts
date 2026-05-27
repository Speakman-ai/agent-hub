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
import {
  previewProxyMountPath,
  previewUpstreamPath,
  resolvePreviewUpstreamHost,
} from './preview-public-url.js';

export type PreviewProxyDeps = {
  getSessionPreviewPort: (sessionId: string) => number | null;
  userOwnsSession: (req: AuthenticatedRequest, sessionId: string) => boolean;
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
 */
export function injectHtmlPreviewBaseHref(html: string, sessionId: string): string {
  const baseHref = `${previewProxyMountPath(sessionId)}/`;
  const baseTag = `<base href="${baseHref}">`;
  if (/<base\b[^>]*>/i.test(html)) {
    return html.replace(/<base\b[^>]*>/i, baseTag);
  }
  if (/<head[\s>]/i.test(html)) {
    return html.replace(/<head([^>]*)>/i, `<head$1>${baseTag}`);
  }
  return `${baseTag}${html}`;
}

function upstreamRequestHeaders(
  req: IncomingMessage,
  port: number,
): Record<string, string | string[]> {
  const headers = copyHeaders(req);
  const upstreamHost = resolvePreviewUpstreamHost();
  headers.host = `${upstreamHost}:${port}`;
  return headers;
}

function proxyHttp(req: Request, res: Response, sessionId: string, port: number): void {
  const upstreamHost = resolvePreviewUpstreamHost();
  const path = previewUpstreamPath(req.originalUrl, sessionId);
  const headers = upstreamRequestHeaders(req, port);

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
      const contentType = String(proxyRes.headers['content-type'] ?? '');
      const shouldRewriteHtml = contentType.includes('text/html');

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
        let body = Buffer.concat(chunks);
        const text = body.toString('utf8');
        const rewritten = injectHtmlPreviewBaseHref(text, sessionId);
        body = Buffer.from(rewritten, 'utf8');
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

  req.pipe(proxyReq);
}

function denyUpgrade(socket: Duplex, statusLine: string): void {
  socket.write(`${statusLine}\r\n\r\n`);
  socket.destroy();
}

function buildUpgradeRequestLines(req: IncomingMessage, path: string, port: number): string {
  const upstreamHost = resolvePreviewUpstreamHost();
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

  const port = deps.getSessionPreviewPort(sessionId);
  if (port == null) {
    denyUpgrade(socket, 'HTTP/1.1 503 Service Unavailable');
    return;
  }

  const upstreamHost = resolvePreviewUpstreamHost();
  const path = previewUpstreamPath(req.url, sessionId);

  const proxySocket = net.connect({ host: upstreamHost, port }, () => {
    proxySocket.write(buildUpgradeRequestLines(req, path, port));
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
 */
export function attachPreviewProxyUpgrade(server: Server, deps: PreviewProxyDeps): void {
  server.prependListener('upgrade', (req, socket, head) => {
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
    const port = deps.getSessionPreviewPort(sessionId);
    if (port == null) {
      res.status(503).send('No active preview for this session');
      return;
    }
    proxyHttp(req, res, sessionId, port);
  };
}

/** Default wiring for `index.ts` — same port lookup as the HTTP proxy routes. */
export function attachDefaultPreviewProxyUpgrade(
  server: Server,
  lookup: Pick<PreviewProxyDeps, 'getSessionPreviewPort'>,
): void {
  attachPreviewProxyUpgrade(server, {
    getSessionPreviewPort: lookup.getSessionPreviewPort,
    userOwnsSession: defaultUserOwnsSession,
  });
}
