/**
 * proxy-server.test.ts — Tests for the lightweight HTTP/WebSocket reverse proxy.
 *
 * Spins up a real target HTTP server on an ephemeral port and proxies
 * requests through createProxyServer() to verify end-to-end behavior.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import { createProxyServer } from './proxy-server.js';
import type { AddressInfo } from 'net';

// ── Test target server ──────────────────────────────────────────

let targetServer: http.Server;
let targetPort: number;
let targetUrl: string;

beforeAll(
  () =>
    new Promise<void>((resolve) => {
      targetServer = http.createServer((req, res) => {
        if (req.url === '/echo-headers') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(
            JSON.stringify({
              host: req.headers.host,
              xForwardedHost: req.headers['x-forwarded-host'],
            }),
          );
          return;
        }

        if (req.url === '/hello') {
          res.writeHead(200, { 'content-type': 'text/plain' });
          res.end('Hello from target');
          return;
        }

        if (req.url === '/post-body' && req.method === 'POST') {
          let body = '';
          req.on('data', (chunk: Buffer) => {
            body += chunk.toString();
          });
          req.on('end', () => {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ received: body }));
          });
          return;
        }

        if (req.url === '/slow') {
          // Don't respond — used to test timeout
          return;
        }

        res.writeHead(404);
        res.end('Not found');
      });

      targetServer.listen(0, '127.0.0.1', () => {
        const addr = targetServer.address() as AddressInfo;
        targetPort = addr.port;
        targetUrl = `http://127.0.0.1:${targetPort}`;
        resolve();
      });
    }),
);

afterAll(
  () =>
    new Promise<void>((resolve) => {
      targetServer.close(() => resolve());
    }),
);

// ── Helper: make a proxy HTTP request and collect the response ──

function proxyRequest(
  proxy: ReturnType<typeof createProxyServer>,
  target: string,
  opts: { method?: string; url?: string; body?: string; headers?: Record<string, string> } = {},
): Promise<{ statusCode: number; body: string; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    // Spin up a real proxy server per request so pipe() works naturally
    const proxyServer = http.createServer((inReq, inRes) => {
      proxy.web(inReq, inRes, target, (err) => {
        if (!inRes.headersSent) {
          inRes.writeHead(502);
          inRes.end(err.message);
        }
      });
    });

    proxyServer.listen(0, '127.0.0.1', () => {
      const addr = proxyServer.address() as AddressInfo;
      const reqOpts: http.RequestOptions = {
        hostname: '127.0.0.1',
        port: addr.port,
        path: opts.url || '/',
        method: opts.method || 'GET',
        headers: {
          host: 'preview-pr-42.preview.example.com',
          ...opts.headers,
        },
      };

      const req = http.request(reqOpts, (res) => {
        const resChunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => resChunks.push(chunk));
        res.on('end', () => {
          proxyServer.close();
          resolve({
            statusCode: res.statusCode || 0,
            body: Buffer.concat(resChunks).toString(),
            headers: res.headers,
          });
        });
      });

      req.on('error', (err) => {
        proxyServer.close();
        reject(err);
      });

      if (opts.body) {
        req.write(opts.body);
      }
      req.end();
    });
  });
}

// ── Tests ────────────────────────────────────────────────────────

describe('proxy-server', () => {
  describe('web() — HTTP proxying', () => {
    it('proxies a GET request and returns the response', async () => {
      const proxy = createProxyServer();
      const result = await proxyRequest(proxy, targetUrl, { url: '/hello' });
      expect(result.statusCode).toBe(200);
      expect(result.body).toBe('Hello from target');
    });

    it('rewrites the Host header to the target', async () => {
      const proxy = createProxyServer();
      const result = await proxyRequest(proxy, targetUrl, { url: '/echo-headers' });
      expect(result.statusCode).toBe(200);
      const parsed = JSON.parse(result.body);
      expect(parsed.host).toBe(`127.0.0.1:${targetPort}`);
    });

    it('sets x-forwarded-host to the original host', async () => {
      const proxy = createProxyServer();
      const result = await proxyRequest(proxy, targetUrl, { url: '/echo-headers' });
      const parsed = JSON.parse(result.body);
      expect(parsed.xForwardedHost).toBe('preview-pr-42.preview.example.com');
    });

    it('proxies POST requests with body', async () => {
      const proxy = createProxyServer();
      const result = await proxyRequest(proxy, targetUrl, {
        method: 'POST',
        url: '/post-body',
        body: '{"test":true}',
        headers: { 'content-type': 'application/json' },
      });
      expect(result.statusCode).toBe(200);
      const parsed = JSON.parse(result.body);
      expect(parsed.received).toBe('{"test":true}');
    });

    it('returns 404 from target for unknown paths', async () => {
      const proxy = createProxyServer();
      const result = await proxyRequest(proxy, targetUrl, { url: '/nonexistent' });
      expect(result.statusCode).toBe(404);
    });

    it('calls onError when target is unreachable', async () => {
      const proxy = createProxyServer();
      const result = await proxyRequest(proxy, 'http://127.0.0.1:1', { url: '/hello' });
      // The proxy server wrapper returns 502 on error
      expect(result.statusCode).toBe(502);
    });
  });
});
