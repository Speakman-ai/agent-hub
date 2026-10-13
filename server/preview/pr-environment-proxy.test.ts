import http from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import request from 'supertest';
import { WebSocket, WebSocketServer } from 'ws';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  attachPrEnvironmentUpgrade,
  createPrEnvironmentProxyMiddleware,
  DEFAULT_RESPONSE_HEADER_TIMEOUT_MS,
  responseHeaderTimeoutFromEnv,
  parseUpstreamUrl,
  presentPrEnvironmentUrl,
  type PrEnvironmentIngressRecord,
  type PrEnvironmentProxyDeps,
} from './pr-environment-proxy.js';
import { claimUpgrade, isUpgradeClaimed } from '../upgrade-claim.js';

const BASE = 'preview.agenthub.example.com';
const host = (pr: number, project = 'demo') => `pr-${pr}--${project}.${BASE}`;

// A stand-in PR app: serves an index that references an absolute asset path,
// echoes what it saw, and echoes websocket messages.
let upstream: http.Server;
let upstreamWss: WebSocketServer;
let upstreamUrl: string;
let deadUpstreamUrl: string;
let silentRequests = 0;
let silentClosed = 0;

// The Hub: the ingress middleware + upgrade listener, then a stand-in for the
// rest of the Hub (CORS / routes) and a stand-in Hub websocket listener.
let hub: http.Server;
let hubUrl: string;
let records: Map<string, PrEnvironmentIngressRecord>;
const hubUpgradeSeen: string[] = [];

function deps(): PrEnvironmentProxyDeps {
  return {
    getBase: () => BASE,
    responseHeaderTimeoutMs: 300,
    lookup: ({ projectLabel, prNumber }) => records.get(`${projectLabel}#${prNumber}`) ?? null,
  };
}

function app(): express.Express {
  const a = express();
  a.use(createPrEnvironmentProxyMiddleware(deps()));
  // Anything below must never run for a PR environment host.
  a.use(express.json());
  a.use((_req, res) => {
    res.status(200).send('hub');
  });
  return a;
}

beforeAll(async () => {
  upstream = http.createServer((req, res) => {
    if (req.url === '/') {
      res.setHeader('content-type', 'text/html');
      res.end('<html><head><script src="/assets/app.js"></script></head></html>');
      return;
    }
    if (req.url === '/sse') {
      // Headers flushed at once, first event only after a delay.
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.flushHeaders();
      setTimeout(() => res.end('data: hi\n\n'), 800);
      return;
    }
    if (req.url === '/slow-body') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.write('first-');
      setTimeout(() => res.end('second'), 600);
      return;
    }
    if (req.url === '/silent') {
      // Accepts the request, never answers.
      silentRequests += 1;
      req.socket.on('close', () => (silentClosed += 1));
      return;
    }
    if (req.url === '/truncated') {
      // Headers and part of the body, then the app's connection drops.
      res.writeHead(200, { 'content-type': 'text/plain', 'content-length': '100' });
      res.write('partial');
      setTimeout(() => req.socket.destroy(), 20);
      return;
    }
    if (req.url === '/assets/app.js') {
      res.setHeader('content-type', 'text/javascript');
      res.end('console.log("app")');
      return;
    }
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      res.setHeader('set-cookie', 'sid=1; Path=/');
      res.end(
        JSON.stringify({
          method: req.method,
          url: req.url,
          host: req.headers.host,
          xfHost: req.headers['x-forwarded-host'],
          xfProto: req.headers['x-forwarded-proto'],
          xff: req.headers['x-forwarded-for'],
          body,
        }),
      );
    });
  });
  upstreamWss = new WebSocketServer({ server: upstream });
  upstreamWss.on('connection', (ws, req) => {
    ws.on('message', (m) => ws.send(`echo:${req.url}:${m.toString()}`));
  });
  await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', r));
  upstreamUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;

  // A port nothing listens on: bind then close.
  const tmp = http.createServer();
  await new Promise<void>((r) => tmp.listen(0, '127.0.0.1', r));
  deadUpstreamUrl = `http://127.0.0.1:${(tmp.address() as AddressInfo).port}`;
  await new Promise<void>((r) => tmp.close(() => r()));

  records = new Map();
  hub = http.createServer(app());
  hub.on('upgrade', (req, socket) => {
    if (isUpgradeClaimed(req)) return;
    hubUpgradeSeen.push(req.url ?? '');
    socket.destroy();
  });
  attachPrEnvironmentUpgrade(hub, deps());
  await new Promise<void>((r) => hub.listen(0, '127.0.0.1', r));
  hubUrl = `http://127.0.0.1:${(hub.address() as AddressInfo).port}`;
});

afterAll(async () => {
  upstreamWss.close();
  await new Promise<void>((r) => upstream.close(() => r()));
  await new Promise<void>((r) => hub.close(() => r()));
});

function setRecord(pr: number, rec: Partial<PrEnvironmentIngressRecord>, project = 'demo') {
  records.set(`${project}#${pr}`, {
    projectId: project,
    status: 'ready',
    upstreamUrl,
    stopReason: null,
    ...rec,
  });
}

describe('PR environment HTTP ingress', () => {
  it('serves the app at / and resolves absolute asset paths', async () => {
    setRecord(1, {});
    const index = await request(hub).get('/').set('Host', host(1));
    expect(index.status).toBe(200);
    expect(index.text).toContain('src="/assets/app.js"');
    // No <base href> rewriting: the app owns `/`.
    expect(index.text).not.toContain('<base');
    const asset = await request(hub).get('/assets/app.js').set('Host', host(1));
    expect(asset.status).toBe(200);
    expect(asset.text).toBe('console.log("app")');
  });

  it('keeps the public Host, adds X-Forwarded-*, and streams bodies past the Hub parsers', async () => {
    setRecord(2, {});
    const res = await request(hub)
      .post('/api/things?x=1')
      .set('Host', host(2))
      .set('X-Forwarded-For', '203.0.113.9')
      .set('Content-Type', 'application/json')
      .send('{"a":1}');
    expect(res.status).toBe(200);
    expect(res.headers['set-cookie']).toEqual(['sid=1; Path=/']);
    expect(res.body).toMatchObject({
      method: 'POST',
      url: '/api/things?x=1',
      host: host(2),
      xfHost: host(2),
      xfProto: 'http',
      body: '{"a":1}',
    });
    expect(res.body.xff).toMatch(/^203\.0\.113\.9, /);
  });

  it('passes the request through untouched for preflights (no Hub CORS)', async () => {
    setRecord(3, {});
    const res = await request(hub)
      .options('/api')
      .set('Host', host(3))
      .set('Origin', 'https://elsewhere.example')
      .set('Access-Control-Request-Method', 'POST');
    expect(res.body.method).toBe('OPTIONS');
  });

  it('leaves non-PR hosts to the rest of the Hub', async () => {
    const res = await request(hub).get('/').set('Host', 'agenthub.example.com');
    expect(res.text).toBe('hub');
    const session = await request(hub)
      .get('/')
      .set('Host', `b371b1ba-37d3-4a10-8b44-40bd1cddcc6d.${BASE}`);
    expect(session.text).toBe('hub');
  });

  it('resolves the project label case-insensitively via the lookup', async () => {
    setRecord(4, {});
    const res = await request(hub).get('/assets/app.js').set('Host', host(4, 'DEMO'));
    expect(res.status).toBe(200);
  });

  it('returns a 404 status page for an unknown environment', async () => {
    const res = await request(hub).get('/').set('Host', host(404));
    expect(res.status).toBe(404);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    expect(res.text).toContain('No environment');
    expect(res.text).toContain('PR #404');
  });

  it('returns a self-refreshing 503 page while the environment builds', async () => {
    setRecord(5, { status: 'building', upstreamUrl: null });
    const res = await request(hub).get('/').set('Host', host(5));
    expect(res.status).toBe(503);
    expect(res.headers['retry-after']).toBe('10');
    expect(res.text).toContain('http-equiv="refresh"');
    expect(res.text).toContain('Environment starting');
  });

  it('returns a 410 page for a stopped environment, with the reason', async () => {
    setRecord(6, { status: 'stopped', upstreamUrl: null, stopReason: 'merged' });
    const res = await request(hub).get('/').set('Host', host(6));
    expect(res.status).toBe(410);
    expect(res.text).toContain('pull request was merged');
  });

  it('returns a status page for a failed environment without leaking details', async () => {
    setRecord(7, { status: 'failed', upstreamUrl: null });
    const res = await request(hub).get('/').set('Host', host(7));
    expect(res.status).toBe(503);
    expect(res.text).toContain('failed to start');
  });

  it('ends the client response when the upstream drops mid-body', async () => {
    setRecord(9, {});
    const outcome = await new Promise<string>((resolve) => {
      const timer = setTimeout(() => resolve('hung'), 3_000);
      const done = (what: string) => {
        clearTimeout(timer);
        resolve(what);
      };
      const req = http.get(`${hubUrl}/truncated`, { headers: { host: host(9) } }, (res) => {
        expect(res.statusCode).toBe(200);
        res.on('data', () => {});
        res.on('aborted', () => done('aborted'));
        res.on('error', () => done('aborted'));
        res.on('end', () => done('ended'));
      });
      req.on('error', () => done('aborted'));
    });
    // A truncated body must surface as an aborted response, not a hang (and
    // never as a clean end the client would take as complete).
    expect(outcome).toBe('aborted');
  }, 10_000);

  it('answers with the 503 page when the upstream never sends headers', async () => {
    setRecord(10, {});
    const started = Date.now();
    const res = await request(hub).get('/silent').set('Host', host(10));
    expect(res.status).toBe(503);
    expect(res.text).toContain('did not respond');
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(silentRequests).toBeGreaterThan(0);
    // The stalled upstream request is torn down, not left open.
    await new Promise((r) => setTimeout(r, 50));
    expect(silentClosed).toBe(silentRequests);
  });

  it('forwards upstream headers before the first body chunk (SSE)', async () => {
    setRecord(12, {});
    const started = Date.now();
    const timing = await new Promise<{ headersAt: number; bodyAt: number }>((resolve, reject) => {
      const req = http.get(`${hubUrl}/sse`, { headers: { host: host(12) } }, (res) => {
        const headersAt = Date.now() - started;
        expect(res.headers['content-type']).toBe('text/event-stream');
        res.once('data', () => resolve({ headersAt, bodyAt: Date.now() - started }));
      });
      req.on('error', reject);
    });
    // Headers arrive well before the upstream's delayed first event.
    expect(timing.headersAt).toBeLessThan(400);
    expect(timing.bodyAt).toBeGreaterThanOrEqual(700);
  }, 10_000);

  it('does not fire the header deadline once headers have arrived', async () => {
    setRecord(11, {});
    // Headers at once, body finished well past the 300ms header deadline.
    const res = await request(hub).get('/slow-body').set('Host', host(11));
    expect(res.status).toBe(200);
    expect(res.text).toBe('first-second');
  });

  it('returns a status page, not a 502, when the upstream is down', async () => {
    setRecord(8, { upstreamUrl: deadUpstreamUrl });
    const res = await request(hub).get('/').set('Host', host(8));
    expect(res.status).toBe(503);
    expect(res.text).toContain('did not respond');
    expect(res.text).not.toContain('127.0.0.1');
  });
});

function openWs(path: string, hostHeader: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${hubUrl.replace('http', 'ws')}${path}`, {
      headers: { host: hostHeader },
    });
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
    ws.once('unexpected-response', (_req, res) => reject(new Error(`status ${res.statusCode}`)));
  });
}

describe('PR environment websocket ingress', () => {
  it('tunnels upgrades to the app, even on Hub-looking paths, without reaching Hub listeners', async () => {
    setRecord(21, {});
    // A path that looks like a Hub websocket route must still go to the app.
    const ws = await openWs('/api/sessions/abc/terminal/ws', host(21));
    const echoed = new Promise<string>((r) => ws.once('message', (m) => r(m.toString())));
    ws.send('ping');
    expect(await echoed).toBe('echo:/api/sessions/abc/terminal/ws:ping');
    ws.close();
    expect(hubUpgradeSeen).not.toContain('/api/sessions/abc/terminal/ws');
  });

  it('refuses upgrades for environments that are not ready', async () => {
    setRecord(22, { status: 'building', upstreamUrl: null });
    await expect(openWs('/', host(22))).rejects.toThrow('status 503');
    await expect(openWs('/', host(999))).rejects.toThrow('status 404');
  });
});

describe('presentPrEnvironmentUrl', () => {
  const env = { projectId: 'Demo', prNumber: 9, url: 'http://10.0.3.7:41234' };

  it('swaps the upstream for the public wildcard URL', () => {
    expect(presentPrEnvironmentUrl(env, BASE, 'https://agenthub.example.com').url).toBe(
      `https://pr-9--demo.${BASE}/`,
    );
  });

  it('leaves a null url alone (nothing to serve yet)', () => {
    expect(presentPrEnvironmentUrl({ ...env, url: null }, BASE, null).url).toBeNull();
  });

  it('falls back to http://localhost:<port> on a local Hub without a base', () => {
    for (const h of ['127.0.0.1', 'host.docker.internal', '[::1]']) {
      expect(presentPrEnvironmentUrl({ ...env, url: `http://${h}:4321` }, null, null).url).toBe(
        'http://localhost:4321',
      );
    }
    // A remote upstream without a base is kept as-is.
    expect(presentPrEnvironmentUrl(env, null, null).url).toBe(env.url);
  });
});

describe('responseHeaderTimeoutFromEnv', () => {
  it('reads a positive override and falls back to the default otherwise', () => {
    expect(responseHeaderTimeoutFromEnv({ AGENT_HUB_PR_ENV_RESPONSE_TIMEOUT_MS: '1500' })).toBe(
      1500,
    );
    for (const v of [undefined, '', '0', '-5', 'soon']) {
      expect(responseHeaderTimeoutFromEnv({ AGENT_HUB_PR_ENV_RESPONSE_TIMEOUT_MS: v })).toBe(
        DEFAULT_RESPONSE_HEADER_TIMEOUT_MS,
      );
    }
  });
});

describe('parseUpstreamUrl', () => {
  it('accepts http host:port and rejects anything else', () => {
    expect(parseUpstreamUrl('http://10.0.0.5:3000')).toEqual({ host: '10.0.0.5', port: 3000 });
    expect(parseUpstreamUrl('http://[::1]:3000')).toEqual({ host: '::1', port: 3000 });
    expect(parseUpstreamUrl('https://10.0.0.5:3000')).toBeNull();
    expect(parseUpstreamUrl('not a url')).toBeNull();
    expect(parseUpstreamUrl(null)).toBeNull();
  });
});

describe('upgrade claims', () => {
  it('marks a request as owned', () => {
    const req = {} as http.IncomingMessage;
    expect(isUpgradeClaimed(req)).toBe(false);
    claimUpgrade(req);
    expect(isUpgradeClaimed(req)).toBe(true);
  });
});
