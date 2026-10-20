import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createAgentPaneFeedHost,
  DESKTOP_AGENT_BUSY_MESSAGE,
  DESKTOP_INPUT_NOT_ALLOWED_MESSAGE,
  DESKTOP_INPUT_STALE_MESSAGE,
  type AgentPaneBrowserSource,
  type AgentPaneFeedHost,
} from './agent-pane-screencast.js';
import type { ScreencastFrame, ScreencastState, ScreencastViewer } from './browser-screencast.js';
import {
  __resetDesktopAgentActivityForTests,
  beginDesktopAgentOp,
} from './desktop/desktop-agent-activity.js';
import {
  createDesktopScreencastHub,
  type DesktopScreencastHub,
} from './desktop/desktop-screencast.js';
import { createFakeDesktopRuntime, type FakeDesktopRuntime } from './test/fake-desktop-runtime.js';

const CHAT = 'chat-1';
const KEY = { userId: 'u1', agentId: 'a1', projectId: 'p1' };

const WEB_LIVE: ScreencastState = {
  status: 'live',
  url: 'https://example.com/',
  viewport: { width: 1280, height: 720 },
  surface: 'web',
};
const WAITING: ScreencastState = { status: 'waiting', url: null, viewport: null, surface: null };

class FakeBrowser implements AgentPaneBrowserSource {
  viewers: ScreencastViewer[] = [];
  state: ScreencastState = WAITING;
  driving = false;
  inputs: unknown[] = [];
  private listeners = new Set<(id: string) => void>();

  attach(_chat: string, viewer: ScreencastViewer) {
    this.viewers.push(viewer);
    viewer.onState(this.state);
    return () => {
      this.viewers = this.viewers.filter((v) => v !== viewer);
    };
  }
  async input(_chat: string, input: unknown) {
    this.inputs.push(input);
    return { ok: true as const };
  }
  async navigate(_chat: string, url: string) {
    return { ok: true as const, url };
  }
  isAgentDriving() {
    return this.driving;
  }
  subscribeActivity(l: (id: string) => void) {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }
  setState(s: ScreencastState) {
    this.state = s;
    for (const v of this.viewers) v.onState(s);
  }
  frame(data: string) {
    for (const v of this.viewers) {
      v.onFrame({
        data,
        width: 1280,
        height: 720,
        viewportWidth: 1280,
        viewportHeight: 720,
        url: null,
      });
    }
  }
  activity(driving: boolean) {
    this.driving = driving;
    for (const l of this.listeners) l(CHAT);
  }
}

interface Setup {
  host: AgentPaneFeedHost;
  hub: DesktopScreencastHub;
  browser: FakeBrowser;
  rt: FakeDesktopRuntime;
}
const setups: Setup[] = [];

function setup(
  opts: { key?: typeof KEY | null; inputAllowed?: (chat: string) => boolean } = {},
): Setup {
  const rt = createFakeDesktopRuntime();
  const browser = new FakeBrowser();
  const hub = createDesktopScreencastHub({
    runtime: () => rt,
    intervalMs: 60_000,
    settleMs: 0,
    logger: { warn: () => {} },
  });
  const host = createAgentPaneFeedHost({
    browser,
    desktop: {
      hub,
      runtime: () => rt,
      resolveKey: () => (opts.key === undefined ? KEY : opts.key),
      ...(opts.inputAllowed ? { inputAllowed: opts.inputAllowed } : {}),
    },
  });
  const s = { host, hub, browser, rt };
  setups.push(s);
  return s;
}

function paneViewer(id = 'pane-1') {
  const states: ScreencastState[] = [];
  const frames: ScreencastFrame[] = [];
  const viewer: ScreencastViewer = {
    id,
    onState: (st) => states.push(st),
    onFrame: (f) => frames.push(f),
  };
  return { viewer, states, frames };
}

afterEach(() => {
  for (const s of setups.splice(0)) {
    s.host.dispose();
    s.hub.dispose();
  }
  __resetDesktopAgentActivityForTests();
});

describe('agent pane feed host', () => {
  it('shows the browser while the desktop is stopped', async () => {
    const { host, hub, browser } = setup();
    browser.state = WEB_LIVE;
    const p = paneViewer();
    host.attach(CHAT, p.viewer);
    await hub.tickAll();
    expect(p.states.at(-1)?.surface).toBe('web');
    browser.frame('JPEG');
    expect(p.frames.map((f) => f.data)).toEqual(['JPEG']);
  });

  it('switches to the desktop surface when only the desktop is live', async () => {
    const { host, hub, rt } = setup();
    rt.state = 'running';
    const p = paneViewer();
    host.attach(CHAT, p.viewer);
    await hub.tickAll();
    await hub.tickAll();
    expect(p.states.at(-1)?.surface).toBe('desktop');
    expect(p.frames.at(-1)?.mime).toBe('image/png');
  });

  it('follows the agent: desktop op wins, then a browser op takes it back', async () => {
    const { host, hub, browser, rt } = setup();
    browser.state = WEB_LIVE;
    rt.state = 'running';
    const p = paneViewer();
    host.attach(CHAT, p.viewer);
    await hub.tickAll();
    expect(p.states.at(-1)?.surface).toBe('web');

    const end = beginDesktopAgentOp(KEY);
    expect(p.states.at(-1)?.surface).toBe('desktop');
    end();
    // Last driven: stays on the desktop after the op.
    await hub.tickAll();
    expect(p.states.at(-1)?.surface).toBe('desktop');
    browser.frame('ignored-while-desktop');
    expect(p.frames.some((f) => f.data === 'ignored-while-desktop')).toBe(false);

    browser.activity(true);
    expect(p.states.at(-1)?.surface).toBe('web');
    expect(p.frames.at(-1)?.data).toBe('ignored-while-desktop');
  });

  it('does not replay a web frame under the preview state after a hidden surface change', async () => {
    const { host, hub, browser, rt } = setup();
    browser.state = WEB_LIVE;
    rt.state = 'running';
    const p = paneViewer();
    host.attach(CHAT, p.viewer);
    await hub.tickAll();
    browser.frame('WEB-JPEG');

    const end = beginDesktopAgentOp(KEY);
    await hub.tickAll();
    expect(p.states.at(-1)?.surface).toBe('desktop');
    end();

    // While the desktop is shown, the agent moves to the preview Chromium.
    browser.setState({ ...WEB_LIVE, url: 'http://localhost:3050/', surface: 'preview' });
    const framesBefore = p.frames.length;
    browser.activity(true);
    expect(p.states.at(-1)?.surface).toBe('preview');
    expect(p.frames.slice(framesBefore).some((f) => f.data === 'WEB-JPEG')).toBe(false);

    browser.frame('PREVIEW-JPEG');
    expect(p.frames.at(-1)?.data).toBe('PREVIEW-JPEG');
  });

  describe('last driven surface outlives the pane', () => {
    it('opens on the desktop when a desktop op finished before the pane was first opened', async () => {
      const { host, hub, browser, rt } = setup();
      browser.state = WEB_LIVE;
      rt.state = 'running';
      beginDesktopAgentOp(KEY)();
      const p = paneViewer();
      host.attach(CHAT, p.viewer);
      await hub.tickAll();
      await hub.tickAll();
      expect(p.states.at(-1)?.surface).toBe('desktop');
    });

    it('reopens on the desktop after a desktop op made while the pane was closed', async () => {
      const { host, hub, browser, rt } = setup();
      browser.state = WEB_LIVE;
      rt.state = 'running';
      const first = paneViewer();
      const detach = host.attach(CHAT, first.viewer);
      await hub.tickAll();
      expect(first.states.at(-1)?.surface).toBe('web');
      detach();

      beginDesktopAgentOp(KEY)();
      const again = paneViewer('pane-2');
      host.attach(CHAT, again.viewer);
      await hub.tickAll();
      await hub.tickAll();
      expect(again.states.at(-1)?.surface).toBe('desktop');
    });

    it('reopens on the desktop it was following when the last viewer left', async () => {
      const { host, hub, browser, rt } = setup();
      browser.state = WEB_LIVE;
      rt.state = 'running';
      const first = paneViewer();
      const detach = host.attach(CHAT, first.viewer);
      await hub.tickAll();
      beginDesktopAgentOp(KEY)();
      await hub.tickAll();
      expect(first.states.at(-1)?.surface).toBe('desktop');
      detach();

      const again = paneViewer('pane-2');
      host.attach(CHAT, again.viewer);
      await hub.tickAll();
      await hub.tickAll();
      expect(again.states.at(-1)?.surface).toBe('desktop');
    });

    it('a later browser op while the pane was closed wins over an earlier desktop op', async () => {
      const { host, hub, browser, rt } = setup();
      browser.state = WEB_LIVE;
      rt.state = 'running';
      beginDesktopAgentOp(KEY)();
      browser.activity(true);
      browser.activity(false);
      const p = paneViewer();
      host.attach(CHAT, p.viewer);
      await hub.tickAll();
      await hub.tickAll();
      expect(p.states.at(-1)?.surface).toBe('web');
    });
  });

  it('refuses human desktop input while the agent has an op in flight', async () => {
    const { host, hub, rt } = setup();
    rt.state = 'running';
    host.attach(CHAT, paneViewer().viewer);
    await hub.tickAll();
    const end = beginDesktopAgentOp(KEY);
    const r = await host.input(CHAT, { kind: 'text', text: 'hi' });
    expect(r).toEqual({ ok: false, code: 'agent_busy', message: DESKTOP_AGENT_BUSY_MESSAGE });
    expect(rt.inputs).toHaveLength(0);
    end();
    await expect(host.input(CHAT, { kind: 'text', text: 'hi' })).resolves.toEqual({ ok: true });
    expect(rt.inputs).toEqual([{ type: 'type', text: 'hi' }]);
  });

  it('routes pointer down/up to one desktop click, in order with typed text', async () => {
    const { host, hub, rt, browser } = setup();
    rt.state = 'running';
    host.attach(CHAT, paneViewer().viewer);
    await hub.tickAll();
    let release!: () => void;
    rt.inputDelay = new Promise((r) => (release = r));
    const results = [
      host.input(CHAT, { kind: 'mouse', type: 'down', x: 10, y: 20 }),
      host.input(CHAT, { kind: 'mouse', type: 'up', x: 10, y: 20 }),
      host.input(CHAT, { kind: 'text', text: 'abc' }),
    ];
    release();
    await Promise.all(results);
    expect(rt.inputs).toEqual([
      { type: 'click', x: 10, y: 20, button: 'left' },
      { type: 'type', text: 'abc' },
    ]);
    expect(browser.inputs).toHaveLength(0);
    expect(rt.wakeCalls).toBe(0);
  });

  it('refuses human desktop input once computer access is revoked', async () => {
    let allowed = true;
    const { host, hub, rt } = setup({ inputAllowed: () => allowed });
    rt.state = 'running';
    host.attach(CHAT, paneViewer().viewer);
    await hub.tickAll();
    await expect(host.input(CHAT, { kind: 'text', text: 'a' })).resolves.toEqual({ ok: true });
    allowed = false;
    const r = await host.input(CHAT, { kind: 'text', text: 'b' });
    expect(r).toEqual({
      ok: false,
      code: 'no_desktop',
      message: DESKTOP_INPUT_NOT_ALLOWED_MESSAGE,
    });
    expect(rt.inputs).toEqual([{ type: 'type', text: 'a' }]);
  });

  it('does not boot a stopped desktop for human input', async () => {
    const { host, hub, rt } = setup();
    rt.state = 'running';
    host.attach(CHAT, paneViewer().viewer);
    await hub.tickAll();
    rt.state = 'stopped';
    const r = await host.input(CHAT, { kind: 'text', text: 'x' });
    expect(r).toMatchObject({ ok: false, code: 'no_desktop' });
    expect(rt.inputs).toHaveLength(0);
  });

  it('refuses URL-bar navigation on the desktop and passes it through on the browser', async () => {
    const { host, hub, rt } = setup();
    rt.state = 'running';
    host.attach(CHAT, paneViewer().viewer);
    await hub.tickAll();
    await expect(host.navigate(CHAT, 'https://example.com')).resolves.toMatchObject({
      ok: false,
      code: 'refused',
    });
  });

  it('sends input to the browser when the session has no desktop key', async () => {
    const { host, browser, hub } = setup({ key: null });
    browser.state = WEB_LIVE;
    host.attach(CHAT, paneViewer().viewer);
    await hub.tickAll();
    await host.input(CHAT, { kind: 'text', text: 'x' });
    expect(browser.inputs).toHaveLength(1);
  });

  it('keeps pointer gestures separate per viewer on the same chat', async () => {
    const { host, hub, rt } = setup();
    rt.state = 'running';
    host.attach(CHAT, paneViewer('tab-a').viewer);
    host.attach(CHAT, paneViewer('tab-b').viewer);
    await hub.tickAll();
    await host.input(CHAT, { kind: 'mouse', type: 'down', x: 10, y: 20 }, 'tab-a');
    await host.input(CHAT, { kind: 'mouse', type: 'down', x: 300, y: 400 }, 'tab-b');
    await host.input(CHAT, { kind: 'mouse', type: 'up', x: 10, y: 20 }, 'tab-a');
    await host.input(CHAT, { kind: 'mouse', type: 'up', x: 600, y: 500 }, 'tab-b');
    expect(rt.inputs).toEqual([
      { type: 'click', x: 10, y: 20, button: 'left' },
      { type: 'drag', fromX: 300, fromY: 400, toX: 600, toY: 500 },
    ]);
  });

  it('drops a pending press when the viewer detaches', async () => {
    const { host, hub, rt } = setup();
    rt.state = 'running';
    host.attach(CHAT, paneViewer('keep').viewer);
    const detach = host.attach(CHAT, paneViewer('gone').viewer);
    await hub.tickAll();
    await host.input(CHAT, { kind: 'mouse', type: 'down', x: 10, y: 20 }, 'gone');
    detach();
    host.attach(CHAT, paneViewer('gone').viewer);
    await host.input(CHAT, { kind: 'mouse', type: 'up', x: 400, y: 300 }, 'gone');
    // The press died with the old attachment, so its up is not turned into a click.
    expect(rt.inputs).toEqual([]);
  });

  describe('queued input whose route went stale', () => {
    async function pendingFirstInput() {
      const s = setup();
      s.rt.state = 'running';
      s.browser.state = WEB_LIVE;
      const v = paneViewer('tab');
      const detach = s.host.attach(CHAT, v.viewer);
      await s.hub.tickAll();
      // Desktop shown because the agent drove it last.
      beginDesktopAgentOp(KEY)();
      expect(v.states.at(-1)?.surface).toBe('desktop');
      let release!: () => void;
      s.rt.inputDelay = new Promise((r) => (release = r));
      const first = s.host.input(CHAT, { kind: 'text', text: 'first' }, 'tab');
      // `first` is now inside runtime.input; everything below waits behind it.
      await vi.waitFor(() => expect(s.rt.inputCalls).toBe(1));
      const down = s.host.input(CHAT, { kind: 'mouse', type: 'down', x: 5, y: 5 }, 'tab');
      const up = s.host.input(CHAT, { kind: 'mouse', type: 'up', x: 5, y: 5 }, 'tab');
      const text = s.host.input(CHAT, { kind: 'text', text: 'second' }, 'tab');
      return { ...s, v, detach, release, first, down, up, text };
    }

    it('drops queued desktop input after the pane switches to the browser', async () => {
      const q = await pendingFirstInput();
      q.browser.activity(true);
      expect(q.v.states.at(-1)?.surface).toBe('web');
      q.release();
      await expect(q.first).resolves.toEqual({ ok: true });
      const stale = { ok: false, code: 'no_desktop', message: DESKTOP_INPUT_STALE_MESSAGE };
      await expect(q.down).resolves.toEqual(stale);
      await expect(q.up).resolves.toEqual(stale);
      await expect(q.text).resolves.toEqual(stale);
      expect(q.rt.inputs).toEqual([{ type: 'type', text: 'first' }]);
      expect(q.browser.inputs).toEqual([]);
    });

    it('drops queued desktop input after the viewer detaches', async () => {
      const q = await pendingFirstInput();
      // A second tab keeps the router (and the desktop surface) alive.
      q.host.attach(CHAT, paneViewer('other').viewer);
      q.detach();
      q.release();
      await q.first;
      await expect(q.text).resolves.toMatchObject({ ok: false, code: 'no_desktop' });
      await expect(q.up).resolves.toMatchObject({ ok: false });
      expect(q.rt.inputs).toEqual([{ type: 'type', text: 'first' }]);
    });

    it('drops queued desktop input after the last viewer leaves', async () => {
      const q = await pendingFirstInput();
      q.detach();
      q.release();
      await q.first;
      await expect(q.text).resolves.toMatchObject({ ok: false, code: 'no_desktop' });
      expect(q.rt.inputs).toEqual([{ type: 'type', text: 'first' }]);
    });

    it('refuses input from a viewer id that is not attached', async () => {
      const { host, hub, rt } = setup();
      rt.state = 'running';
      host.attach(CHAT, paneViewer('tab').viewer);
      await hub.tickAll();
      await expect(host.input(CHAT, { kind: 'text', text: 'x' }, 'ghost')).resolves.toMatchObject({
        ok: false,
        code: 'no_desktop',
      });
      expect(rt.inputs).toEqual([]);
    });
  });

  describe('agent activity invalidates human input', () => {
    it('drops a press made before an agent op: down -> agent op -> up sends nothing', async () => {
      const { host, hub, rt } = setup();
      rt.state = 'running';
      const v = paneViewer('tab');
      host.attach(CHAT, v.viewer);
      await hub.tickAll();
      expect(v.states.at(-1)?.surface).toBe('desktop');
      await host.input(CHAT, { kind: 'mouse', type: 'down', x: 10, y: 10 }, 'tab');
      beginDesktopAgentOp(KEY)();
      expect(v.states.at(-1)?.surface).toBe('desktop');
      await expect(
        host.input(CHAT, { kind: 'mouse', type: 'up', x: 200, y: 200 }, 'tab'),
      ).resolves.toEqual({ ok: true });
      expect(rt.inputs).toEqual([]);
      // A fresh gesture after the op works normally.
      await host.input(CHAT, { kind: 'mouse', type: 'down', x: 30, y: 40 }, 'tab');
      await host.input(CHAT, { kind: 'mouse', type: 'up', x: 30, y: 40 }, 'tab');
      expect(rt.inputs).toEqual([{ type: 'click', x: 30, y: 40, button: 'left' }]);
    });

    it('drops input queued before an agent op that started and finished meanwhile', async () => {
      const { host, hub, rt } = setup();
      rt.state = 'running';
      host.attach(CHAT, paneViewer('tab').viewer);
      await hub.tickAll();
      let release!: () => void;
      rt.inputDelay = new Promise((r) => (release = r));
      const first = host.input(CHAT, { kind: 'text', text: 'first' }, 'tab');
      await vi.waitFor(() => expect(rt.inputCalls).toBe(1));
      const queued = host.input(CHAT, { kind: 'text', text: 'queued' }, 'tab');
      beginDesktopAgentOp(KEY)();
      release();
      await first;
      await expect(queued).resolves.toEqual({
        ok: false,
        code: 'no_desktop',
        message: DESKTOP_INPUT_STALE_MESSAGE,
      });
      expect(rt.inputs).toEqual([{ type: 'type', text: 'first' }]);
    });

    it('drops a wheel remainder built up before an agent op', async () => {
      const { host, hub, rt } = setup();
      rt.state = 'running';
      host.attach(CHAT, paneViewer('tab').viewer);
      await hub.tickAll();
      await host.input(CHAT, { kind: 'wheel', x: 5, y: 5, deltaX: 0, deltaY: 80 }, 'tab');
      beginDesktopAgentOp(KEY)();
      await host.input(CHAT, { kind: 'wheel', x: 5, y: 5, deltaX: 0, deltaY: 30 }, 'tab');
      expect(rt.inputs).toEqual([]);
    });
  });
});
