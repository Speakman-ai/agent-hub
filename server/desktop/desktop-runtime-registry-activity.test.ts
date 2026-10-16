import { afterEach, describe, expect, it } from 'vitest';
import { createAgentPaneFeedHost } from '../agent-pane-screencast.js';
import type { ScreencastState, ScreencastViewer } from '../browser-screencast.js';
import { createFakeDesktopRuntime } from '../test/fake-desktop-runtime.js';
import {
  __resetDesktopAgentActivityForTests,
  desktopAgentOpsInFlight,
} from './desktop-agent-activity.js';
import {
  getDesktopRuntime,
  getDesktopRuntimeForLiveView,
  registerDesktopRuntime,
  resetDesktopRuntimesForTests,
} from './desktop-runtime-registry.js';
import { createDesktopScreencastHub } from './desktop-screencast.js';

const KEY = { userId: 'u1', agentId: 'a1', projectId: 'p1' };

afterEach(() => {
  resetDesktopRuntimesForTests();
  __resetDesktopAgentActivityForTests();
});

describe('registry runtime counts agent ops', () => {
  it('brackets exec / input / screenshot / start, including when they throw', async () => {
    const rt = createFakeDesktopRuntime();
    registerDesktopRuntime(rt);
    const agent = getDesktopRuntime('container')!;
    expect(getDesktopRuntime('container')).toBe(agent);

    let release!: () => void;
    rt.execDelay = new Promise((r) => (release = r));
    const pending = agent.exec(KEY, 'ls');
    expect(desktopAgentOpsInFlight(KEY)).toBe(1);
    release();
    await pending;
    expect(desktopAgentOpsInFlight(KEY)).toBe(0);

    rt.input = async () => {
      expect(desktopAgentOpsInFlight(KEY)).toBe(1);
      throw new Error('xdotool failed');
    };
    await expect(agent.input(KEY, { type: 'type', text: 'x' })).rejects.toThrow('xdotool');
    expect(desktopAgentOpsInFlight(KEY)).toBe(0);

    await agent.ensureStarted(KEY);
    await agent.screenshot(KEY);
    await agent.status(KEY);
    await agent.viewFrame(KEY);
    expect(desktopAgentOpsInFlight(KEY)).toBe(0);
  });

  it('leaves the live-view runtime untracked', async () => {
    const rt = createFakeDesktopRuntime();
    registerDesktopRuntime(rt);
    expect(getDesktopRuntimeForLiveView('container')).toBe(rt);
  });

  it('an agent op through the registry moves the pane to the desktop and blocks human input', async () => {
    const rt = createFakeDesktopRuntime();
    rt.state = 'running';
    registerDesktopRuntime(rt);
    const liveView = () => getDesktopRuntimeForLiveView('container');
    const hub = createDesktopScreencastHub({
      runtime: liveView,
      intervalMs: 60_000,
      settleMs: 0,
      logger: { warn: () => {} },
    });
    const webLive: ScreencastState = {
      status: 'live',
      url: 'https://example.com/',
      viewport: { width: 1280, height: 720 },
      surface: 'web',
    };
    const host = createAgentPaneFeedHost({
      browser: {
        attach: (_id, v) => {
          v.onState(webLive);
          return () => {};
        },
        input: async () => ({ ok: true }),
        navigate: async (_id, url) => ({ ok: true, url }),
        isAgentDriving: () => false,
        subscribeActivity: () => () => {},
      },
      desktop: { hub, runtime: liveView, resolveKey: () => KEY },
    });
    try {
      const states: ScreencastState[] = [];
      const viewer: ScreencastViewer = {
        id: 'pane',
        onState: (s) => states.push(s),
        onFrame: () => {},
      };
      host.attach('chat', viewer);
      await hub.tickAll();
      expect(states.at(-1)?.surface).toBe('web');

      let release!: () => void;
      rt.execDelay = new Promise((r) => (release = r));
      const op = getDesktopRuntime('container')!.exec(KEY, 'firefox &');
      expect(states.at(-1)?.surface).toBe('desktop');
      await expect(host.input('chat', { kind: 'text', text: 'hi' })).resolves.toMatchObject({
        ok: false,
        code: 'agent_busy',
      });
      release();
      await op;
      // The human's own input goes through the untracked runtime and is not an agent op.
      await expect(host.input('chat', { kind: 'text', text: 'hi' })).resolves.toEqual({ ok: true });
      expect(desktopAgentOpsInFlight(KEY)).toBe(0);
      expect(rt.inputs).toEqual([{ type: 'type', text: 'hi' }]);
    } finally {
      host.dispose();
      hub.dispose();
    }
  });
});
