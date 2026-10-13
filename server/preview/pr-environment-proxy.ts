/**
 * Public ingress for PR environments: `pr-<n>--<project>.<previewBase>`.
 *
 * The ALB sends the whole `*.<previewBase>` wildcard to the Hub. Requests
 * whose Host names a PR environment are reverse-proxied here to the
 * environment's upstream (`http://<runner-ip>:<port>`, recorded on the
 * `pr_environments` row once it is ready). The app is served at `/`, so
 * absolute asset paths work with no per-app base-path config.
 *
 * Access is gated by `./pr-environment-share.ts` when a gate is passed: Hub
 * members arrive with a ticket from the PR page, external testers with a
 * share link. Requests on an environment host never reach Hub routes or Hub
 * cookies (different host), and anything that is not ready gets a status
 * page instead of a bare 502.
 *
 * The middleware must be mounted before CORS and body parsers: the app's
 * own preflights and request bodies have to reach the upstream untouched.
 */
import http from 'node:http';
import net from 'node:net';
import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { PrEnvironmentStatus, PrEnvironmentStopReason } from './pr-environment-state.js';
import {
  buildPrEnvironmentPublicUrl,
  parsePrEnvironmentHost,
  type PrEnvironmentHostTarget,
} from './preview-subdomain-host.js';
import { claimUpgrade } from '../upgrade-claim.js';
import {
  stripAccessCookies,
  type AccessPage,
  type PrEnvironmentAccessGate,
} from './pr-environment-share.js';

/** What the lifecycle table says about the addressed environment. */
export interface PrEnvironmentIngressRecord {
  projectId: string;
  status: PrEnvironmentStatus;
  /** Upstream base URL (`http://host:port`) once ready, else null. */
  upstreamUrl: string | null;
  stopReason: PrEnvironmentStopReason | null;
}

export interface PrEnvironmentProxyDeps {
  /** `AGENT_HUB_PREVIEW_SUBDOMAIN_BASE`; ingress is off when unset. */
  getBase: () => string | null | undefined;
  /**
   * Resolve a parsed hostname to its environment. `null` when the project or
   * the PR has no environment row.
   */
  lookup: (target: PrEnvironmentHostTarget) => PrEnvironmentIngressRecord | null;
  /**
   * How long to wait for the upstream's response headers before giving up
   * with the "not responding" page. Only the headers are bounded; a response
   * that has started may stream for as long as it likes.
   */
  responseHeaderTimeoutMs?: number;
  /** Who may use an environment. Without one the ingress is open. */
  gate?: PrEnvironmentAccessGate;
}

/**
 * Default header deadline: under the ALB's default 60s idle timeout, so the
 * browser gets the status page rather than the ALB's 504.
 */
export const DEFAULT_RESPONSE_HEADER_TIMEOUT_MS = 55_000;

/** `AGENT_HUB_PR_ENV_RESPONSE_TIMEOUT_MS`, else the default. */
export function responseHeaderTimeoutFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.AGENT_HUB_PR_ENV_RESPONSE_TIMEOUT_MS);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_RESPONSE_HEADER_TIMEOUT_MS;
}

const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'trailers',
  'transfer-encoding',
  'upgrade',
]);

/** Seconds a "starting" page waits before reloading itself. */
const STARTING_REFRESH_SECONDS = 10;

export interface UpstreamTarget {
  host: string;
  port: number;
}

/** Parse `http://host:port` from the row. Anything else is not routable. */
export function parseUpstreamUrl(raw: string | null | undefined): UpstreamTarget | null {
  if (!raw) return null;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== 'http:') return null;
  const port = Number(u.port || '80');
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (!host) return null;
  return { host, port };
}

export interface StatusPage {
  status: number;
  title: string;
  message: string;
  /** Auto-reload interval; set while the environment is still coming up. */
  refreshSeconds: number | null;
  link?: AccessPage['link'];
  passwordForm?: AccessPage['passwordForm'];
}

/**
 * The page shown instead of the app when the environment cannot serve.
 * Never includes the row's error text or upstream address: this page is
 * public, and both can carry internal detail.
 */
export function statusPageFor(
  target: PrEnvironmentHostTarget,
  record: PrEnvironmentIngressRecord | null,
): StatusPage | null {
  const pr = `PR #${target.prNumber}`;
  if (!record) {
    return {
      status: 404,
      title: 'No environment',
      message: `There is no environment for ${pr} in project "${target.projectLabel}".`,
      refreshSeconds: null,
    };
  }
  switch (record.status) {
    case 'queued':
    case 'building':
      return {
        status: 503,
        title: 'Environment starting',
        message: `The environment for ${pr} is ${record.status === 'queued' ? 'queued' : 'building'}. This page reloads automatically when it is ready.`,
        refreshSeconds: STARTING_REFRESH_SECONDS,
      };
    case 'failed':
      return {
        status: 503,
        title: 'Environment failed',
        message: `The environment for ${pr} failed to start. Open the pull request in Agent Hub to see its logs and retry.`,
        refreshSeconds: null,
      };
    case 'stopped': {
      const why =
        record.stopReason === 'merged'
          ? ' because the pull request was merged'
          : record.stopReason === 'closed'
            ? ' because the pull request was closed'
            : record.stopReason === 'no_preview_config'
              ? ' because its head no longer declares a preview'
              : '';
      return {
        status: 410,
        title: 'Environment stopped',
        message: `The environment for ${pr} was stopped${why}.`,
        refreshSeconds: null,
      };
    }
    case 'ready':
      if (parseUpstreamUrl(record.upstreamUrl)) return null;
      return {
        status: 503,
        title: 'Environment starting',
        message: `The environment for ${pr} is not reachable yet. This page reloads automatically.`,
        refreshSeconds: STARTING_REFRESH_SECONDS,
      };
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function renderStatusPage(page: StatusPage): string {
  const refresh =
    page.refreshSeconds != null
      ? `<meta http-equiv="refresh" content="${page.refreshSeconds}">`
      : '';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
${refresh}<title>${escapeHtml(page.title)}</title>
<style>
body{font-family:system-ui,-apple-system,sans-serif;background:#0f1115;color:#e6e6e6;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}
main{max-width:32rem;padding:2rem;text-align:center}
h1{font-size:1.25rem;margin:0 0 .75rem}
p{color:#a8adb7;line-height:1.5;margin:0}
a{color:#7cb3ff}
form{margin-top:1.25rem;display:flex;gap:.5rem;justify-content:center}
input{padding:.5rem .75rem;border-radius:.375rem;border:1px solid #333a45;background:#171a21;color:#e6e6e6}
button{padding:.5rem 1rem;border-radius:.375rem;border:0;background:#2563eb;color:#fff;cursor:pointer}
.err{color:#f87171;margin-top:.75rem}
</style>
</head>
<body><main><h1>${escapeHtml(page.title)}</h1><p>${escapeHtml(page.message)}</p>${extras(page)}</main></body>
</html>
`;
}

function extras(page: StatusPage): string {
  let out = '';
  if (page.passwordForm) {
    out += `<form method="post" action="${escapeHtml(page.passwordForm.action)}"><input type="password" name="password" autocomplete="current-password" aria-label="Password" required autofocus><button type="submit">Continue</button></form>`;
    if (page.passwordForm.error) out += `<p class="err">${escapeHtml(page.passwordForm.error)}</p>`;
  }
  if (page.link) {
    out += `<p style="margin-top:1rem"><a href="${escapeHtml(page.link.href)}">${escapeHtml(page.link.label)}</a></p>`;
  }
  return out;
}

export function sendStatusPage(res: Response, page: StatusPage): void {
  res.statusCode = page.status;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Robots-Tag', 'noindex');
  if (page.refreshSeconds != null) res.setHeader('Retry-After', String(page.refreshSeconds));
  res.end(renderStatusPage(page));
}

function unreachablePage(target: PrEnvironmentHostTarget): StatusPage {
  return {
    status: 503,
    title: 'Environment not responding',
    message: `The environment for PR #${target.prNumber} is running but did not respond. This page reloads automatically.`,
    refreshSeconds: STARTING_REFRESH_SECONDS,
  };
}

function firstHeader(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

/**
 * Headers sent upstream. The original Host is kept so the app sees its public
 * hostname (absolute URLs, cookies); X-Forwarded-* carry the client address
 * and the scheme the ALB terminated.
 */
export function upstreamHeaders(
  req: IncomingMessage,
  opts: { clientIp: string | undefined; proto: string },
): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  const connectionTokens = new Set(
    String(firstHeader(req.headers.connection) ?? '')
      .split(',')
      .map((t) => t.trim().toLowerCase())
      .filter(Boolean),
  );
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    const lower = key.toLowerCase();
    if (HOP_BY_HOP.has(lower) || connectionTokens.has(lower)) continue;
    if (lower === 'cookie') {
      // The ingress's own access cookies carry share tokens; the app never needs them.
      const kept = stripAccessCookies(value);
      if (kept) out.cookie = kept;
      continue;
    }
    out[lower] = value;
  }
  const priorXff = firstHeader(req.headers['x-forwarded-for']);
  if (opts.clientIp) {
    out['x-forwarded-for'] = priorXff ? `${priorXff}, ${opts.clientIp}` : opts.clientIp;
  }
  const host = firstHeader(req.headers.host);
  if (host) out['x-forwarded-host'] = host;
  out['x-forwarded-proto'] = opts.proto;
  return out;
}

function responseHeaders(res: IncomingMessage): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [key, value] of Object.entries(res.headers)) {
    if (value === undefined) continue;
    const lower = key.toLowerCase();
    if (HOP_BY_HOP.has(lower)) continue;
    out[lower] = value;
  }
  return out;
}

function resolve(
  deps: PrEnvironmentProxyDeps,
  host: string | undefined,
):
  | { target: PrEnvironmentHostTarget; record: PrEnvironmentIngressRecord | null }
  | { target: PrEnvironmentHostTarget; lookupFailed: true }
  | null {
  const target = parsePrEnvironmentHost(host, deps.getBase());
  if (!target) return null;
  try {
    return { target, record: deps.lookup(target) };
  } catch {
    // A failed read is not "no environment": say so and let the page retry.
    return { target, lookupFailed: true };
  }
}

/** The lookup or the access check failed (database error). Retryable. */
function unavailablePage(target: PrEnvironmentHostTarget): StatusPage {
  return {
    status: 503,
    title: 'Temporarily unavailable',
    message: `Agent Hub could not look up the environment for PR #${target.prNumber}. This page reloads automatically.`,
    refreshSeconds: STARTING_REFRESH_SECONDS,
  };
}

/** Express middleware: proxy PR environment hosts, pass everything else on. */
export function createPrEnvironmentProxyMiddleware(deps: PrEnvironmentProxyDeps): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    const resolved = resolve(deps, req.headers.host);
    if (!resolved) return next();
    if ('lookupFailed' in resolved) {
      sendStatusPage(res, unavailablePage(resolved.target));
      return;
    }
    const { target, record } = resolved;
    if (record && deps.gate) {
      let verdict: 'proceed' | 'handled';
      try {
        verdict = deps.gate.http(req, res, {
          target,
          projectId: record.projectId,
          prNumber: target.prNumber,
        });
      } catch {
        if (!res.headersSent) sendStatusPage(res, unavailablePage(target));
        return;
      }
      if (verdict === 'handled') return;
    }
    const page = statusPageFor(target, record);
    if (page) {
      sendStatusPage(res, page);
      return;
    }
    const upstream = parseUpstreamUrl(record!.upstreamUrl)!;

    const proxyReq = http.request({
      hostname: upstream.host,
      port: upstream.port,
      method: req.method,
      // The raw URL: this middleware runs before anything rewrites req.url.
      path: req.originalUrl || req.url || '/',
      headers: upstreamHeaders(req, {
        // The immediate peer; the client address is already in any prior XFF.
        clientIp: req.socket.remoteAddress,
        proto: req.protocol,
      }),
    });
    // An upstream that accepts the connection but never answers would
    // otherwise leave the browser waiting on an external timeout.
    const headerTimer = setTimeout(() => {
      proxyReq.destroy();
      if (!res.headersSent) sendStatusPage(res, unreachablePage(target));
    }, deps.responseHeaderTimeoutMs ?? DEFAULT_RESPONSE_HEADER_TIMEOUT_MS);
    headerTimer.unref?.();
    proxyReq.on('response', (proxyRes) => {
      clearTimeout(headerTimer);
      res.writeHead(proxyRes.statusCode ?? 502, responseHeaders(proxyRes));
      // writeHead() only buffers. The header deadline is already cleared, so
      // an app that flushes headers and then waits (SSE, long poll) must get
      // them to the browser now, not with its first body chunk.
      res.flushHeaders();
      // An upstream that drops after the headers aborts proxyRes without an
      // 'end', so pipe() would leave the client waiting until a timeout.
      // Destroying the response aborts it, so the client sees a truncated
      // body as a failure rather than hanging or taking it as complete.
      const abortDownstream = () => {
        if (!res.writableFinished) res.destroy();
      };
      proxyRes.on('aborted', abortDownstream);
      proxyRes.on('error', abortDownstream);
      proxyRes.on('close', () => {
        if (!proxyRes.complete) abortDownstream();
      });
      proxyRes.pipe(res);
    });
    proxyReq.on('error', () => {
      clearTimeout(headerTimer);
      // The header deadline already answered and then destroyed the request.
      if (res.writableEnded) return;
      if (!res.headersSent) {
        sendStatusPage(res, unreachablePage(target));
        return;
      }
      res.destroy();
    });
    // A client that goes away must not leave the upstream request open.
    res.on('close', () => {
      clearTimeout(headerTimer);
      if (!res.writableFinished) proxyReq.destroy();
    });
    req.pipe(proxyReq);
  };
}

function denyUpgrade(socket: Duplex, statusLine: string): void {
  socket.write(`${statusLine}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  socket.destroy();
}

/** The raw HTTP/1.1 upgrade request replayed to the upstream. */
export function buildUpgradeRequest(
  req: IncomingMessage,
  opts: { clientIp: string | undefined; proto: string },
): string {
  const lines = [`${req.method ?? 'GET'} ${req.url || '/'} HTTP/${req.httpVersion || '1.1'}`];
  const headers = upstreamHeaders(req, opts);
  for (const [key, value] of Object.entries(headers)) {
    for (const v of Array.isArray(value) ? value : [value]) lines.push(`${key}: ${v}`);
  }
  // Hop-by-hop headers were stripped above; an upgrade needs these two back.
  lines.push(`connection: Upgrade`);
  lines.push(`upgrade: ${firstHeader(req.headers.upgrade) ?? 'websocket'}`);
  return `${lines.join('\r\n')}\r\n\r\n`;
}

/**
 * Tunnel WebSocket upgrades on PR environment hosts. Runs before every other
 * upgrade listener and claims the request, so the Hub's own WebSocket routes
 * never see a PR app's sockets whatever their path.
 */
export function attachPrEnvironmentUpgrade(server: Server, deps: PrEnvironmentProxyDeps): void {
  server.prependListener('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const resolved = resolve(deps, req.headers.host);
    if (!resolved) return;
    claimUpgrade(req);
    if ('lookupFailed' in resolved) {
      denyUpgrade(socket, 'HTTP/1.1 503 Service Unavailable');
      return;
    }
    const { target, record } = resolved;
    if (record && deps.gate) {
      let allowed: boolean;
      try {
        allowed = deps.gate.upgrade(req, {
          projectId: record.projectId,
          prNumber: target.prNumber,
        });
      } catch {
        denyUpgrade(socket, 'HTTP/1.1 503 Service Unavailable');
        return;
      }
      if (!allowed) {
        denyUpgrade(socket, 'HTTP/1.1 401 Unauthorized');
        return;
      }
    }
    const page = statusPageFor(target, record);
    if (page) {
      denyUpgrade(
        socket,
        page.status === 404
          ? 'HTTP/1.1 404 Not Found'
          : page.status === 410
            ? 'HTTP/1.1 410 Gone'
            : 'HTTP/1.1 503 Service Unavailable',
      );
      return;
    }
    const upstream = parseUpstreamUrl(record!.upstreamUrl)!;
    const forwardedProto = firstHeader(req.headers['x-forwarded-proto']);
    const proto =
      forwardedProto?.split(',')[0]?.trim() ||
      ((req.socket as { encrypted?: boolean }).encrypted ? 'https' : 'http');

    let tunneled = false;
    const upstreamSocket = net.connect({ host: upstream.host, port: upstream.port }, () => {
      tunneled = true;
      upstreamSocket.write(buildUpgradeRequest(req, { clientIp: req.socket.remoteAddress, proto }));
      if (head.length > 0) upstreamSocket.write(head);
      socket.pipe(upstreamSocket);
      upstreamSocket.pipe(socket);
    });
    upstreamSocket.on('error', () => {
      if (socket.destroyed) return;
      // Before the tunnel exists the client is still waiting for an HTTP
      // answer; after, the stream belongs to the app and is just closed.
      if (tunneled) socket.destroy();
      else denyUpgrade(socket, 'HTTP/1.1 503 Service Unavailable');
    });
    socket.on('error', () => {
      if (!upstreamSocket.destroyed) upstreamSocket.destroy();
    });
    socket.on('close', () => {
      if (!upstreamSocket.destroyed) upstreamSocket.destroy();
    });
    upstreamSocket.on('close', () => {
      if (!socket.destroyed) socket.destroy();
    });
  });
}

/**
 * Hosts the local runner records for a port published on the Hub's own
 * machine. A browser on that machine reaches them as `localhost`.
 */
const HUB_LOCAL_UPSTREAM_HOSTS = new Set(['127.0.0.1', '::1', 'localhost', 'host.docker.internal']);

/**
 * The environment as clients see it. A non-null upstream `url` becomes the
 * public `pr-<n>--<project>.<base>` URL when wildcard ingress is configured.
 * Without a base (local / dev Hubs) the direct upstream is kept, shown as
 * `http://localhost:<port>` when it is published on the Hub's machine.
 */
export function presentPrEnvironmentUrl<
  T extends { projectId: string; prNumber: number; url: string | null },
>(env: T, base: string | null | undefined, publicUrl: string | null | undefined): T {
  if (!env.url) return env;
  const url = buildPrEnvironmentPublicUrl(env.prNumber, env.projectId, base, publicUrl);
  if (url) return { ...env, url };
  const upstream = parseUpstreamUrl(env.url);
  if (upstream && HUB_LOCAL_UPSTREAM_HOSTS.has(upstream.host.toLowerCase())) {
    return { ...env, url: `http://localhost:${upstream.port}` };
  }
  return env;
}
