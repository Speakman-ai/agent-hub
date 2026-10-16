import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { once } from 'node:events';
import WebSocket from 'ws';
import { afterEach, describe, expect, it, vi } from 'vitest';
import createWebSocket from './websocket.js';
import type { WebSocketDeps } from './types.js';
import {
  attachBrowserScreencastWebSocket,
  parseBrowserScreencastWebSocketSessionId,
  type BrowserScreencastFeedHost,
  type BrowserScreencastWebSocketHandle,
  type BrowserServerFrame,
} from './browser-screencast-websocket.js';
import type { ScreencastViewer } from './browser-screencast.js';
import { BrowserDemoRecorder } from './browser-demo-recorder.js';
import { createAgentPaneFeedHost } from './agent-pane-screencast.js';
import { createDesktopScreencastHub } from './desktop/desktop-screencast.js';
import {
  __resetDesktopAgentActivityForTests,
  beginDesktopAgentOp,
} from './desktop/desktop-agent-activity.js';
import { createFakeDesktopRuntime } from './test/fake-desktop-runtime.js';
import {
  __resetBrowserLoginHandoffsForTests,
  requestBrowserLogin,
} from './browser-login-handoff.js';

class FakeFeedHost implements BrowserScreencastFeedHost {
  readonly attached: Array<{ sessionId: string; viewer: ScreencastViewer }> = [];
  readonly inputs: unknown[] = [];
  readonly navigations: string[] = [];
  detachCount = 0;
  busy = false;

  attach(sessionId: string, viewer: ScreencastViewer): () => void {
    this.attached.push({ sessionId, viewer });
    viewer.onState({
      status: 'live',
      url: 'https://example.com/',
      viewport: { width: 1280, height: 720 },
      surface: 'web',
    });
    return () => {
      this.detachCount += 1;
    };
  }

  async input(_sessionId: string, input: unknown) {
    this.inputs.push(input);
    if (this.busy) {
      return { ok: false as const, code: 'agent_busy' as const, message: 'busy' };
    }
    return { ok: true as const };
  }

  async navigate(_sessionId: string, url: string) {
    this.navigations.push(url);
    if (url.includes('localhost')) {
      return { ok: false as const, code: 'refused' as const, message: 'localhost is not allowed' };
    }
    return { ok: true as const, url };
  }

  emitFrame(data: string): void {
    for (const { viewer } of this.attached) {
      viewer.onFrame({
        data,
        width: 640,
        height: 360,
        viewportWidth: 1280,
        viewportHeight: 720,
        url: 'https://example.com/',
      });
    }
  }
}

interface Harness {
  server: Server;
  handle: BrowserScreencastWebSocketHandle;
  host: FakeFeedHost;
  url: string;
}

const harnesses: Harness[] = [];

async function makeHarness(
  overrides: Partial<Parameters<typeof attachBrowserScreencastWebSocket>[1]> = {},
): Promise<Harness> {
  const server = createServer();
  const host = new FakeFeedHost();
  const handle = attachBrowserScreencastWebSocket(server, {
    feedHost: host,
    sessionExists: (sessionId) => sessionId === 'owned',
    authenticate: () => ({ ok: true, userId: 'user-1', role: 'User' }),
    userOwnsSession: (_req, sessionId) => sessionId === 'owned',
    attachTimeoutMs: 1_000,
    logger: { warn: () => {} },
    ...overrides,
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = (server.address() as AddressInfo).port;
  const harness = {
    server,
    handle,
    host,
    url: `ws://127.0.0.1:${port}/api/sessions/owned/browser/ws`,
  };
  harnesses.push(harness);
  return harness;
}

async function connect(url: string): Promise<WebSocket> {
  const ws = new WebSocket(url);
  await once(ws, 'open');
  return ws;
}

function collectFrames(ws: WebSocket): BrowserServerFrame[] {
  const frames: BrowserServerFrame[] = [];
  ws.on('message', (raw) => frames.push(JSON.parse(raw.toString()) as BrowserServerFrame));
  return frames;
}

async function rejectedStatus(url: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.once('unexpected-response', (_req, response) => {
      resolve(response.statusCode ?? 0);
      response.resume();
    });
    ws.once('open', () => reject(new Error('WebSocket unexpectedly opened')));
    ws.once('error', () => {});
  });
}

afterEach(async () => {
  for (const { server, handle } of harnesses.splice(0)) {
    handle.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

describe('agent browser WebSocket route', () => {
  it('parses only the dedicated session browser path', () => {
    expect(parseBrowserScreencastWebSocketSessionId('/api/sessions/a%20b/browser/ws?token=x')).toBe(
      'a b',
    );
    expect(parseBrowserScreencastWebSocketSessionId('/api/sessions/a/browser/ws/')).toBe('a');
    expect(parseBrowserScreencastWebSocketSessionId('/api/sessions/a/terminal/ws')).toBeNull();
    expect(parseBrowserScreencastWebSocketSessionId('/api/sessions/%ZZ/browser/ws')).toBeNull();
  });

  it('rejects unauthenticated upgrades before attaching a feed', async () => {
    const { url, host } = await makeHarness({ authenticate: () => ({ ok: false }) });
    await expect(rejectedStatus(url)).resolves.toBe(401);
    expect(host.attached).toEqual([]);
  });

  it('masks a foreign session as 404', async () => {
    const { url, host } = await makeHarness({ userOwnsSession: () => false });
    await expect(rejectedStatus(url)).resolves.toBe(404);
    expect(host.attached).toEqual([]);
  });

  it('refuses with 403 when the browser tool is off for the session', async () => {
    const { url, host } = await makeHarness({ browserToolsEnabled: () => false });
    await expect(rejectedStatus(url)).resolves.toBe(403);
    expect(host.attached).toEqual([]);
  });

  it('attaches, streams state + frames, forwards input and navigation, detaches on close', async () => {
    const { url, host } = await makeHarness();
    const ws = await connect(url);
    const frames = collectFrames(ws);

    ws.send(JSON.stringify({ type: 'attach', maxWidth: 800, maxHeight: 600 }));
    await vi.waitFor(() => expect(frames).toHaveLength(1));
    expect(frames[0]).toEqual({
      type: 'state',
      status: 'live',
      url: 'https://example.com/',
      viewport: { width: 1280, height: 720 },
      surface: 'web',
    });
    expect(host.attached[0]).toMatchObject({
      sessionId: 'owned',
      viewer: { maxWidth: 800, maxHeight: 600 },
    });

    host.emitFrame('AAAA');
    await vi.waitFor(() => expect(frames).toHaveLength(2));
    expect(frames[1]).toMatchObject({ type: 'frame', data: 'AAAA', width: 640, height: 360 });

    ws.send(
      JSON.stringify({
        type: 'input',
        input: { kind: 'mouse', type: 'click', x: 10, y: 20 },
      }),
    );
    await vi.waitFor(() => expect(frames).toHaveLength(3));
    expect(frames[2]).toEqual({ type: 'input_result', ok: true });
    expect(host.inputs).toEqual([{ kind: 'mouse', type: 'click', x: 10, y: 20 }]);

    ws.send(JSON.stringify({ type: 'navigate', url: 'http://localhost:3000/' }));
    await vi.waitFor(() => expect(frames).toHaveLength(4));
    expect(frames[3]).toMatchObject({ type: 'navigated', ok: false, code: 'refused' });

    ws.send(JSON.stringify({ type: 'navigate', url: 'https://example.org/' }));
    await vi.waitFor(() => expect(frames).toHaveLength(5));
    expect(frames[4]).toEqual({ type: 'navigated', ok: true, url: 'https://example.org/' });

    ws.close();
    await vi.waitFor(() => expect(host.detachCount).toBe(1));
  });

  it('rejects malformed frames and input before attach', async () => {
    const { url, host } = await makeHarness();
    const ws = await connect(url);
    const frames = collectFrames(ws);

    ws.send('not json');
    ws.send(
      JSON.stringify({ type: 'input', input: { kind: 'mouse', type: 'teleport', x: 1, y: 1 } }),
    );
    ws.send(JSON.stringify({ type: 'input', input: { kind: 'mouse', type: 'click', x: 1, y: 1 } }));
    await vi.waitFor(() => expect(frames).toHaveLength(3));
    expect(frames.map((f) => (f as { code?: string }).code)).toEqual([
      'invalid_frame',
      'invalid_frame',
      'not_attached',
    ]);
    expect(host.inputs).toEqual([]);
    ws.close();
  });

  it('closes a connection that never attaches', async () => {
    const { url } = await makeHarness({ attachTimeoutMs: 50 });
    const ws = await connect(url);
    const [code] = (await once(ws, 'close')) as [number];
    expect(code).toBe(1008);
  });

  it('is not claimed by the chat WebSocket server', async () => {
    const server = createServer();
    const chat = createWebSocket(server, {
      authenticate: () => ({ ok: true }),
    } as unknown as WebSocketDeps);
    const host = new FakeFeedHost();
    const handle = attachBrowserScreencastWebSocket(server, {
      feedHost: host,
      sessionExists: () => true,
      authenticate: () => ({ ok: true, userId: 'u', role: 'User' }),
      userOwnsSession: () => true,
      attachTimeoutMs: 1_000,
      logger: { warn: () => {} },
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const port = (server.address() as AddressInfo).port;
    harnesses.push({ server, handle, host, url: '' });
    try {
      const ws = await connect(`ws://127.0.0.1:${port}/api/sessions/owned/browser/ws`);
      const frames = collectFrames(ws);
      ws.send(JSON.stringify({ type: 'attach' }));
      await vi.waitFor(() => expect(frames).toHaveLength(1));
      expect(frames[0]).toMatchObject({ type: 'state', status: 'live' });
      expect(host.attached).toHaveLength(1);
      ws.close();
    } finally {
      chat.wss.close();
    }
  });
});

describe('browser screencast WebSocket — sign-in handoff', () => {
  afterEach(() => {
    __resetBrowserLoginHandoffsForTests();
  });

  it('pushes the open request on attach and settles it on Done', async () => {
    const { url } = await makeHarness();
    const { request, settled } = requestBrowserLogin('owned', {
      domain: 'github.com',
      reason: 'Read your notifications',
    });
    const ws = await connect(url);
    const frames = collectFrames(ws);
    ws.send(JSON.stringify({ type: 'attach' }));
    await vi.waitFor(() =>
      expect(frames.find((f) => f.type === 'login_request')).toMatchObject({
        type: 'login_request',
        request: { requestId: request.requestId, domain: 'github.com' },
      }),
    );

    ws.send(JSON.stringify({ type: 'login_done', requestId: request.requestId }));
    await expect(settled).resolves.toEqual({ outcome: 'done' });
    await vi.waitFor(() =>
      expect(frames.filter((f) => f.type === 'login_result')).toEqual([
        { type: 'login_result', ok: true, requestId: request.requestId, outcome: 'done' },
      ]),
    );
    // The resolve event clears the banner on every attached viewer.
    expect(frames.filter((f) => f.type === 'login_request').at(-1)).toEqual({
      type: 'login_request',
      request: null,
    });
    ws.close();
  });

  it('pushes a request opened after attach and reports a stale Cancel', async () => {
    const { url } = await makeHarness();
    const ws = await connect(url);
    const frames = collectFrames(ws);
    ws.send(JSON.stringify({ type: 'attach' }));
    await vi.waitFor(() => expect(frames).toHaveLength(1));
    expect(frames.some((f) => f.type === 'login_request')).toBe(false);

    const { request, settled } = requestBrowserLogin('owned', { domain: 'example.com' });
    await vi.waitFor(() =>
      expect(frames.at(-1)).toMatchObject({
        type: 'login_request',
        request: { requestId: request.requestId },
      }),
    );
    ws.send(JSON.stringify({ type: 'login_cancel', requestId: 'stale' }));
    await vi.waitFor(() =>
      expect(frames.at(-1)).toMatchObject({ type: 'login_result', ok: false, requestId: 'stale' }),
    );
    ws.send(JSON.stringify({ type: 'login_cancel', requestId: request.requestId }));
    await expect(settled).resolves.toEqual({ outcome: 'cancelled' });
    ws.close();
  });

  it('does not leak another session’s request', async () => {
    const { url } = await makeHarness();
    const ws = await connect(url);
    const frames = collectFrames(ws);
    ws.send(JSON.stringify({ type: 'attach' }));
    await vi.waitFor(() => expect(frames).toHaveLength(1));
    requestBrowserLogin('someone-else', { domain: 'example.com' });
    await new Promise((r) => setTimeout(r, 20));
    expect(frames.some((f) => f.type === 'login_request')).toBe(false);
    ws.close();
  });
});

describe('agent browser WebSocket route: desktop surface', () => {
  const KEY = { userId: 'user-1', agentId: 'agent-1', projectId: 'proj-1' };

  async function desktopHarness() {
    const rt = createFakeDesktopRuntime();
    rt.state = 'running';
    const hub = createDesktopScreencastHub({
      runtime: () => rt,
      intervalMs: 20,
      settleMs: 0,
      logger: { warn: () => {} },
    });
    const browserHost = new FakeFeedHost();
    const feedHost = createAgentPaneFeedHost({
      browser: {
        attach: (id, viewer) => {
          browserHost.attached.push({ sessionId: id, viewer });
          viewer.onState({ status: 'waiting', url: null, viewport: null, surface: null });
          return () => {
            browserHost.detachCount += 1;
          };
        },
        input: (id, input) => browserHost.input(id, input),
        navigate: (id, url) => browserHost.navigate(id, url),
        isAgentDriving: () => false,
        subscribeActivity: () => () => {},
      },
      desktop: { hub, runtime: () => rt, resolveKey: () => KEY },
    });
    const harness = await makeHarness({ feedHost });
    return { ...harness, rt, hub, feedHost, browserHost };
  }

  afterEach(() => {
    __resetDesktopAgentActivityForTests();
  });

  it('streams desktop state and PNG frames, and takes human input over the channel', async () => {
    const { url, rt, hub, feedHost, browserHost } = await desktopHarness();
    try {
      const ws = await connect(url);
      const frames = collectFrames(ws);
      ws.send(JSON.stringify({ type: 'attach' }));
      await vi.waitFor(() =>
        expect(frames.some((f) => f.type === 'state' && f.surface === 'desktop')).toBe(true),
      );
      await vi.waitFor(() => expect(frames.some((f) => f.type === 'frame')).toBe(true));
      const frame = frames.find((f) => f.type === 'frame');
      expect(frame).toMatchObject({ mime: 'image/png', width: 1280, height: 800 });

      ws.send(
        JSON.stringify({ type: 'input', input: { kind: 'mouse', type: 'down', x: 5, y: 6 } }),
      );
      ws.send(JSON.stringify({ type: 'input', input: { kind: 'mouse', type: 'up', x: 5, y: 6 } }));
      await vi.waitFor(() =>
        expect(rt.inputs).toEqual([{ type: 'click', x: 5, y: 6, button: 'left' }]),
      );
      expect(browserHost.inputs).toEqual([]);

      const end = beginDesktopAgentOp(KEY);
      ws.send(JSON.stringify({ type: 'input', input: { kind: 'text', text: 'hi' } }));
      await vi.waitFor(() =>
        expect(
          frames.some((f) => f.type === 'input_result' && !f.ok && f.code === 'agent_busy'),
        ).toBe(true),
      );
      end();
      expect(rt.inputs).toHaveLength(1);

      ws.send(JSON.stringify({ type: 'navigate', url: 'https://example.com' }));
      await vi.waitFor(() =>
        expect(frames.some((f) => f.type === 'navigated' && !f.ok)).toBe(true),
      );
      expect(browserHost.navigations).toEqual([]);
      expect(rt.wakeCalls).toBe(0);
      ws.close();
    } finally {
      feedHost.dispose();
      hub.dispose();
    }
  });

  it('keeps gestures from two connections on the same session apart', async () => {
    const { url, rt, hub, feedHost } = await desktopHarness();
    try {
      const a = await connect(url);
      const b = await connect(url);
      const aFrames = collectFrames(a);
      const bFrames = collectFrames(b);
      a.send(JSON.stringify({ type: 'attach' }));
      b.send(JSON.stringify({ type: 'attach' }));
      const liveDesktop = (frames: BrowserServerFrame[]) =>
        frames.some((f) => f.type === 'state' && f.surface === 'desktop');
      await vi.waitFor(() => expect(liveDesktop(aFrames) && liveDesktop(bFrames)).toBe(true));
      const send = (ws: WebSocket, type: 'down' | 'up', x: number, y: number) =>
        ws.send(JSON.stringify({ type: 'input', input: { kind: 'mouse', type, x, y } }));
      const results = (frames: BrowserServerFrame[]) =>
        frames.filter((f) => f.type === 'input_result').length;
      send(a, 'down', 10, 20);
      await vi.waitFor(() => expect(results(aFrames)).toBe(1));
      send(b, 'down', 300, 400);
      await vi.waitFor(() => expect(results(bFrames)).toBe(1));
      send(a, 'up', 10, 20);
      await vi.waitFor(() => expect(rt.inputs).toHaveLength(1));
      expect(rt.inputs[0]).toEqual({ type: 'click', x: 10, y: 20, button: 'left' });
      a.close();
      b.close();
    } finally {
      feedHost.dispose();
      hub.dispose();
    }
  });
});

describe('agent browser WebSocket route: demo recording', () => {
  it('starts, reports, stops, and announces the saved artifact to the pane', async () => {
    const recorder = new BrowserDemoRecorder({
      currentUrl: () => 'https://example.com/',
      save: async () => ({ id: 'art-9', filename: 'browser-demo-x.json', url: '/content' }),
    });
    const { url } = await makeHarness({ demoRecorder: recorder });
    const ws = await connect(url);
    const frames = collectFrames(ws);
    ws.send(JSON.stringify({ type: 'record_start' }));
    await vi.waitFor(() => expect(frames.map((f) => f.type)).toContain('error'));
    expect(recorder.isRecording('owned')).toBe(false);

    ws.send(JSON.stringify({ type: 'attach' }));
    ws.send(JSON.stringify({ type: 'record_start' }));
    await vi.waitFor(() =>
      expect(frames).toContainEqual(
        expect.objectContaining({
          type: 'recording',
          state: expect.objectContaining({ active: true }),
        }),
      ),
    );
    ws.send(JSON.stringify({ type: 'record_start' }));
    await vi.waitFor(() =>
      expect(frames).toContainEqual(expect.objectContaining({ type: 'recording_error' })),
    );

    // A second pane joining mid-recording learns it is in progress.
    const late = await connect(url);
    const lateFrames = collectFrames(late);
    late.send(JSON.stringify({ type: 'attach' }));
    await vi.waitFor(() => expect(lateFrames.map((f) => f.type)).toContain('recording'));

    ws.send(JSON.stringify({ type: 'record_stop' }));
    await vi.waitFor(() =>
      expect(frames).toContainEqual({
        type: 'recording_saved',
        artifact: { id: 'art-9', filename: 'browser-demo-x.json', url: '/content' },
        steps: 0,
        stopReason: 'stopped',
      }),
    );
    await vi.waitFor(() => expect(lateFrames.map((f) => f.type)).toContain('recording_saved'));
    ws.close();
    late.close();
    recorder.resetForTests();
  });
});
