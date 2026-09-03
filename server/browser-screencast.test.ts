import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  __registerBrowserSessionForTests,
  __resetBrowserRegistryForTests,
  __unregisterBrowserSessionForTests,
  browserToolOpsInFlight,
  incrementBrowserToolOpEntered,
  notifyBrowserToolOpEnded,
  DEFAULT_TIMEOUT_MS,
  type BrowserSession,
} from './browser.js';
import {
  __resetBrowserScreencastForTests,
  attachBrowserScreencastViewer,
  dispatchBrowserViewerInput,
  getBrowserScreencastState,
  navigateBrowserViewer,
  playwrightKeyFromDomKey,
  type ScreencastFrame,
  type ScreencastState,
} from './browser-screencast.js';

class FakeCdp {
  readonly sent: Array<{ method: string; params?: object }> = [];
  readonly handlers = new Map<string, Set<(p: unknown) => void>>();
  detached = 0;
  /** When set, `Page.captureScreenshot` resolves with this base64 payload. */
  captureScreenshotData: string | null = null;
  async send(method: string, params?: object): Promise<unknown> {
    this.sent.push({ method, params });
    if (method === 'Page.captureScreenshot' && this.captureScreenshotData) {
      return { data: this.captureScreenshotData };
    }
    return {};
  }
  on(event: string, handler: (p: unknown) => void): void {
    if (!this.handlers.has(event)) this.handlers.set(event, new Set());
    this.handlers.get(event)!.add(handler);
  }
  off(event: string, handler: (p: unknown) => void): void {
    this.handlers.get(event)?.delete(handler);
  }
  async detach(): Promise<void> {
    this.detached += 1;
  }
  emit(event: string, params: unknown): void {
    for (const h of Array.from(this.handlers.get(event) ?? [])) h(params);
  }
}

function makeFakeSession(id: string) {
  const cdp = new FakeCdp();
  let url = 'https://example.com/';
  const page = {
    url: () => url,
    goto: vi.fn(async (u: string) => {
      url = u;
    }),
    screenshot: vi.fn(async () => Buffer.from('')),
    locator: () => ({ click: async () => {}, fill: async () => {} }),
    evaluate: async () => '',
    viewportSize: () => ({ width: 1280, height: 720 }),
    mouse: {
      wheel: vi.fn(async () => {}),
      move: vi.fn(async () => {}),
      down: vi.fn(async () => {}),
      up: vi.fn(async () => {}),
      click: vi.fn(async () => {}),
    },
    keyboard: {
      press: vi.fn(async () => {}),
      type: vi.fn(async () => {}),
      insertText: vi.fn(async () => {}),
      down: vi.fn(async () => {}),
      up: vi.fn(async () => {}),
    },
  };
  const context = { newCDPSession: vi.fn(async () => cdp) };
  const session: BrowserSession = {
    id,
    page,
    context,
    createdAt: Date.now(),
    timeoutMs: DEFAULT_TIMEOUT_MS,
    close: async () => {},
  };
  return { session, page, cdp, context };
}

function makeViewer(id: string) {
  const frames: ScreencastFrame[] = [];
  const states: ScreencastState[] = [];
  return {
    frames,
    states,
    viewer: {
      id,
      onFrame: (f: ScreencastFrame) => frames.push(f),
      onState: (s: ScreencastState) => states.push(s),
    },
  };
}

beforeEach(async () => {
  await __resetBrowserScreencastForTests();
  __resetBrowserRegistryForTests();
});

afterEach(async () => {
  await __resetBrowserScreencastForTests();
  __resetBrowserRegistryForTests();
});

describe('browser screencast feed', () => {
  it('starts a CDP screencast for the first viewer, fans frames out, and acks each one', async () => {
    const { session, cdp } = makeFakeSession('chat-1');
    __registerBrowserSessionForTests(session);
    const a = makeViewer('a');
    const detachA = attachBrowserScreencastViewer('chat-1', a.viewer);
    await vi.waitFor(() => expect(a.states.at(-1)?.status).toBe('live'));

    expect(cdp.sent.map((c) => c.method)).toContain('Page.startScreencast');
    expect(a.states.at(-1)).toMatchObject({
      status: 'live',
      url: 'https://example.com/',
      viewport: { width: 1280, height: 720 },
    });

    cdp.emit('Page.screencastFrame', {
      data: 'AAAA',
      metadata: { deviceWidth: 640, deviceHeight: 360 },
      sessionId: 7,
    });
    expect(a.frames).toHaveLength(1);
    expect(a.frames[0]).toMatchObject({
      data: 'AAAA',
      width: 640,
      height: 360,
      viewportWidth: 1280,
      viewportHeight: 720,
      url: 'https://example.com/',
    });
    await vi.waitFor(() =>
      expect(cdp.sent).toContainEqual({
        method: 'Page.screencastFrameAck',
        params: { sessionId: 7 },
      }),
    );

    // A late viewer joins the existing feed: no second screencast, gets the last frame.
    const b = makeViewer('b');
    const detachB = attachBrowserScreencastViewer('chat-1', b.viewer);
    expect(cdp.sent.filter((c) => c.method === 'Page.startScreencast')).toHaveLength(1);
    expect(b.states.at(-1)?.status).toBe('live');
    expect(b.frames).toHaveLength(1);

    detachA();
    // Feed still alive for b — no stop yet.
    expect(cdp.sent.map((c) => c.method)).not.toContain('Page.stopScreencast');
    detachB();
    await vi.waitFor(() => expect(cdp.sent.map((c) => c.method)).toContain('Page.stopScreencast'));
    await vi.waitFor(() => expect(cdp.detached).toBe(1));
  });

  it('seeds one captured frame on attach so a static, already-loaded page is not blank', async () => {
    const { session, cdp } = makeFakeSession('chat-seed');
    cdp.captureScreenshotData = 'SEEDFRAME';
    __registerBrowserSessionForTests(session);
    const v = makeViewer('seed');
    attachBrowserScreencastViewer('chat-seed', v.viewer);
    await vi.waitFor(() => expect(v.states.at(-1)?.status).toBe('live'));

    // No Page.screencastFrame event is ever emitted (the page is static), yet
    // the viewer must still paint from the forced capture.
    await vi.waitFor(() => expect(v.frames).toHaveLength(1));
    expect(cdp.sent.map((c) => c.method)).toContain('Page.captureScreenshot');
    expect(v.frames[0]).toMatchObject({
      data: 'SEEDFRAME',
      viewportWidth: 1280,
      viewportHeight: 720,
      url: 'https://example.com/',
    });

    // A real screencast frame supersedes the seed rather than duplicating it.
    cdp.emit('Page.screencastFrame', {
      data: 'REALFRAME',
      metadata: { deviceWidth: 1280, deviceHeight: 720 },
      sessionId: 3,
    });
    expect(v.frames).toHaveLength(2);
    expect(v.frames[1]).toMatchObject({ data: 'REALFRAME' });
  });

  it('does not seed a frame when CDP cannot produce a screenshot (no capture data)', async () => {
    const { session, cdp } = makeFakeSession('chat-noseed');
    // captureScreenshotData stays null → send() returns {} with no data.
    __registerBrowserSessionForTests(session);
    const v = makeViewer('noseed');
    attachBrowserScreencastViewer('chat-noseed', v.viewer);
    await vi.waitFor(() => expect(v.states.at(-1)?.status).toBe('live'));
    // Give any pending seed a chance to run, then assert it produced nothing.
    await Promise.resolve();
    expect(v.frames).toHaveLength(0);
    void cdp;
  });

  it('holds the browser open while a viewer is attached and releases on detach', async () => {
    const { session } = makeFakeSession('chat-hold');
    __registerBrowserSessionForTests(session);
    const v = makeViewer('v');
    const detach = attachBrowserScreencastViewer('chat-hold', v.viewer);
    await vi.waitFor(() => expect(v.states.at(-1)?.status).toBe('live'));
    expect(browserToolOpsInFlight('chat-hold')).toBe(1);
    detach();
    expect(browserToolOpsInFlight('chat-hold')).toBe(0);
  });

  it('reports waiting before the agent opens a browser, then goes live when it launches', async () => {
    const v = makeViewer('early');
    attachBrowserScreencastViewer('chat-2', v.viewer);
    expect(v.states).toEqual([{ status: 'waiting', url: null, viewport: null }]);
    expect(getBrowserScreencastState('chat-2').status).toBe('waiting');

    const { session, cdp } = makeFakeSession('chat-2');
    __registerBrowserSessionForTests(session);
    await vi.waitFor(() => expect(v.states.at(-1)?.status).toBe('live'));
    expect(cdp.sent.map((c) => c.method)).toContain('Page.startScreencast');

    // Session goes away (idle close / explicit close op): viewers learn, feed
    // falls back to waiting so a relaunch re-attaches.
    __unregisterBrowserSessionForTests('chat-2');
    expect(v.states.at(-1)?.status).toBe('closed');
    expect(getBrowserScreencastState('chat-2').status).toBe('waiting');
    expect(browserToolOpsInFlight('chat-2')).toBe(0);
  });

  it('does not attach the preview-drive browser by accident (separate ids)', async () => {
    const { session, cdp } = makeFakeSession('preview:chat-3');
    __registerBrowserSessionForTests(session);
    const v = makeViewer('v');
    attachBrowserScreencastViewer('chat-3', v.viewer);
    expect(v.states.at(-1)?.status).toBe('waiting');
    expect(cdp.sent).toEqual([]);
  });
});

describe('human input forwarding', () => {
  it('maps mouse / wheel / key / text input onto the Playwright page', async () => {
    const { session, page } = makeFakeSession('chat-in');
    __registerBrowserSessionForTests(session);

    expect(
      await dispatchBrowserViewerInput('chat-in', { kind: 'mouse', type: 'click', x: 10, y: 20 }),
    ).toEqual({ ok: true });
    expect(page.mouse.click).toHaveBeenCalledWith(10, 20, { button: 'left', clickCount: 1 });

    await dispatchBrowserViewerInput('chat-in', {
      kind: 'wheel',
      x: 1,
      y: 2,
      deltaX: 0,
      deltaY: 120,
    });
    expect(page.mouse.wheel).toHaveBeenCalledWith(0, 120);

    await dispatchBrowserViewerInput('chat-in', { kind: 'key', type: 'press', key: 'a' });
    expect(page.keyboard.type).toHaveBeenCalledWith('a');

    await dispatchBrowserViewerInput('chat-in', { kind: 'key', type: 'press', key: 'Enter' });
    expect(page.keyboard.press).toHaveBeenCalledWith('Enter');

    await dispatchBrowserViewerInput('chat-in', {
      kind: 'key',
      type: 'press',
      key: 'a',
      modifiers: { ctrl: true },
    });
    expect(page.keyboard.press).toHaveBeenCalledWith('Control+a');

    await dispatchBrowserViewerInput('chat-in', { kind: 'text', text: 'hello' });
    expect(page.keyboard.insertText).toHaveBeenCalledWith('hello');
  });

  it('refuses input while an agent step is in flight, but not for the feed keepalive hold', async () => {
    const { session, page } = makeFakeSession('chat-busy');
    __registerBrowserSessionForTests(session);
    const v = makeViewer('v');
    attachBrowserScreencastViewer('chat-busy', v.viewer);
    await vi.waitFor(() => expect(v.states.at(-1)?.status).toBe('live'));

    // Only the feed hold: input allowed.
    expect(
      await dispatchBrowserViewerInput('chat-busy', { kind: 'mouse', type: 'click', x: 1, y: 1 }),
    ).toEqual({ ok: true });

    incrementBrowserToolOpEntered('chat-busy');
    const r = await dispatchBrowserViewerInput('chat-busy', {
      kind: 'mouse',
      type: 'click',
      x: 1,
      y: 1,
    });
    expect(r).toMatchObject({ ok: false, code: 'agent_busy' });
    expect(page.mouse.click).toHaveBeenCalledTimes(1);
    notifyBrowserToolOpEnded('chat-busy');
  });

  it('reports no_browser when the agent has not opened one', async () => {
    expect(
      await dispatchBrowserViewerInput('nope', { kind: 'mouse', type: 'click', x: 1, y: 1 }),
    ).toMatchObject({ ok: false, code: 'no_browser' });
    expect(await navigateBrowserViewer('nope', 'https://example.com')).toMatchObject({
      ok: false,
      code: 'no_browser',
    });
  });

  it('human URL-bar navigation runs the same egress policy as the agent navigate op', async () => {
    const { session, page } = makeFakeSession('chat-nav');
    __registerBrowserSessionForTests(session);

    const refused = await navigateBrowserViewer('chat-nav', 'http://localhost:3000/');
    expect(refused).toMatchObject({ ok: false, code: 'refused' });
    expect((refused as { message: string }).message).toContain('localhost is not allowed');
    expect(page.goto).not.toHaveBeenCalled();

    const ok = await navigateBrowserViewer('chat-nav', 'https://example.org/docs');
    expect(ok).toEqual({ ok: true, url: 'https://example.org/docs' });
    expect(page.goto).toHaveBeenCalled();
  });

  it('translates DOM key names to Playwright key chords', () => {
    expect(playwrightKeyFromDomKey('a')).toBe('a');
    expect(playwrightKeyFromDomKey(' ')).toBe('Space');
    expect(playwrightKeyFromDomKey('Enter')).toBe('Enter');
    expect(playwrightKeyFromDomKey('ArrowLeft', { shift: true })).toBe('Shift+ArrowLeft');
    expect(playwrightKeyFromDomKey('c', { ctrl: true, alt: true })).toBe('Control+Alt+c');
    expect(playwrightKeyFromDomKey('')).toBeNull();
  });
});
