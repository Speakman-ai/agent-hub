/**
 * proxy-server.ts — Lightweight HTTP/WebSocket reverse proxy using Node built-ins.
 *
 * No external dependencies — uses Node's `http` module to forward requests
 * and WebSocket upgrades to target containers.
 */

import http from 'http';
import type { IncomingMessage, ServerResponse } from 'http';
import type { Socket } from 'net';

/** Default timeout for proxy requests (30 seconds). */
const PROXY_TIMEOUT_MS = 30_000;

export interface ProxyServer {
  /**
   * Proxy an HTTP request to the target URL.
   */
  web(
    req: IncomingMessage,
    res: ServerResponse,
    target: string,
    onError: (err: Error) => void,
  ): void;

  /**
   * Proxy a WebSocket upgrade to the target URL.
   */
  ws(
    req: IncomingMessage,
    socket: Socket,
    head: Buffer,
    target: string,
    onError: (err: Error) => void,
  ): void;
}

/**
 * Build forwarded headers for the proxy request.
 * Rewrites `host` to the target so the container sees localhost:{port},
 * and preserves the original host in `x-forwarded-host`.
 */
function buildProxyHeaders(
  originalHeaders: IncomingMessage['headers'],
  targetUrl: URL,
): Record<string, string | string[] | undefined> {
  return {
    ...originalHeaders,
    host: `${targetUrl.hostname}:${targetUrl.port}`,
    'x-forwarded-host': originalHeaders.host || '',
    'x-forwarded-proto': 'https',
  };
}

/**
 * Create a proxy server instance.
 */
export function createProxyServer(): ProxyServer {
  return {
    web(req, res, target, onError) {
      const url = new URL(target);

      const proxyReq = http.request(
        {
          hostname: url.hostname,
          port: url.port,
          path: req.url || '/',
          method: req.method,
          headers: buildProxyHeaders(req.headers, url),
          timeout: PROXY_TIMEOUT_MS,
        },
        (proxyRes) => {
          res.writeHead(proxyRes.statusCode || 502, proxyRes.headers);
          proxyRes.pipe(res);
        },
      );

      proxyReq.on('timeout', () => {
        proxyReq.destroy(new Error('Proxy request timed out'));
      });

      proxyReq.on('error', onError);

      // Pipe the incoming request body to the proxy request
      req.pipe(proxyReq);
    },

    ws(req, socket, head, target, onError) {
      const url = new URL(target);
      const wsPath = req.url || '/';

      const proxyReq = http.request({
        hostname: url.hostname,
        port: url.port,
        path: wsPath,
        method: 'GET',
        headers: buildProxyHeaders(req.headers, url),
        timeout: PROXY_TIMEOUT_MS,
      });

      proxyReq.on('timeout', () => {
        proxyReq.destroy(new Error('WebSocket proxy connection timed out'));
      });

      proxyReq.on('error', onError);

      proxyReq.on('upgrade', (proxyRes, proxySocket, proxyHead) => {
        // Write the HTTP 101 Switching Protocols response back
        const statusLine = `HTTP/1.1 ${proxyRes.statusCode} ${proxyRes.statusMessage}\r\n`;
        const headers = Object.entries(proxyRes.headers)
          .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : v}`)
          .join('\r\n');

        socket.write(statusLine + headers + '\r\n\r\n');

        // Forward any buffered data
        if (proxyHead && proxyHead.length > 0) {
          socket.write(proxyHead);
        }

        // Bi-directional piping
        proxySocket.pipe(socket);
        socket.pipe(proxySocket);

        proxySocket.on('error', () => socket.destroy());
        socket.on('error', () => proxySocket.destroy());

        proxySocket.on('end', () => socket.end());
        socket.on('end', () => proxySocket.end());
      });

      proxyReq.on('response', (res) => {
        // The target didn't upgrade — return the error to the client
        const statusLine = `HTTP/1.1 ${res.statusCode} ${res.statusMessage}\r\n\r\n`;
        socket.write(statusLine);
        socket.destroy();
      });

      proxyReq.end(head);
    },
  };
}
