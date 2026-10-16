import { afterEach, describe, expect, it } from 'vitest';
import type { ScreencastFrame, ScreencastState } from '../browser-screencast.js';
import { createFakeDesktopRuntime } from '../test/fake-desktop-runtime.js';
import {
  __resetDesktopAgentActivityForTests,
  beginDesktopAgentOp,
} from './desktop-agent-activity.js';
import { createDesktopScreencastHub, type DesktopScreencastHub } from './desktop-screencast.js';

const KEY = { userId: 'u1', agentId: 'a1', projectId: 'p1' };
const hubs: DesktopScreencastHub[] = [];

function makeHub(runtime: ReturnType<typeof createFakeDesktopRuntime> | null) {
  const hub = createDesktopScreencastHub({
    runtime: () => runtime,
    intervalMs: 60_000,
    settleMs: 0,
    logger: { warn: () => {} },
  });
  hubs.push(hub);
  return hub;
}

function viewer(id: string, wants = () => true) {
  const states: ScreencastState[] = [];
  const frames: ScreencastFrame[] = [];
  return {
    states,
    frames,
    viewer: {
      id,
      wantsFrames: wants,
      onState: (s: ScreencastState) => states.push(s),
      onFrame: (f: ScreencastFrame) => frames.push(f),
    },
  };
}

afterEach(() => {
  for (const h of hubs.splice(0)) h.dispose();
  __resetDesktopAgentActivityForTests();
});

describe('desktop screencast feed', () => {
  it('waits while the computer is stopped and never wakes it', async () => {
    const rt = createFakeDesktopRuntime();
    const hub = makeHub(rt);
    const v = viewer('v1');
    hub.attach(KEY, v.viewer);
    await hub.tickAll();
    expect(v.states.at(-1)?.status).toBe('waiting');
    expect(v.frames).toHaveLength(0);
    expect(rt.wakeCalls).toBe(0);
  });

  it('goes live with a desktop badge and PNG frames once the computer runs', async () => {
    const rt = createFakeDesktopRuntime();
    const hub = makeHub(rt);
    const v = viewer('v1');
    hub.attach(KEY, v.viewer);
    await hub.tickAll();
    rt.state = 'running';
    await hub.tickAll();
    expect(v.states.at(-1)).toEqual({
      status: 'live',
      url: null,
      viewport: { width: 1280, height: 800 },
      surface: 'desktop',
    });
    expect(v.frames).toHaveLength(1);
    expect(v.frames[0]).toMatchObject({
      mime: 'image/png',
      width: 1280,
      height: 800,
      data: Buffer.from('PNG-1').toString('base64'),
    });
    expect(hub.isLive(KEY)).toBe(true);
    expect(rt.wakeCalls).toBe(0);
  });

  it('does not resend an unchanged screen, and sends the next change', async () => {
    const rt = createFakeDesktopRuntime();
    rt.state = 'running';
    const hub = makeHub(rt);
    const v = viewer('v1');
    hub.attach(KEY, v.viewer);
    await hub.tickAll();
    await hub.tickAll();
    expect(v.frames).toHaveLength(1);
    rt.png = Buffer.from('PNG-2');
    await hub.tickAll();
    expect(v.frames).toHaveLength(2);
  });

  it('skips captures while no viewer is showing the desktop', async () => {
    const rt = createFakeDesktopRuntime();
    rt.state = 'running';
    const hub = makeHub(rt);
    let showing = false;
    const v = viewer('v1', () => showing);
    hub.attach(KEY, v.viewer);
    await hub.tickAll();
    expect(rt.viewFrames).toBe(0);
    expect(v.states.at(-1)?.status).toBe('live');
    showing = true;
    await hub.tickAll();
    expect(rt.viewFrames).toBe(1);
    expect(v.frames).toHaveLength(1);
  });

  it('replays the last frame to a late viewer and drops back to waiting on stop', async () => {
    const rt = createFakeDesktopRuntime();
    rt.state = 'running';
    const hub = makeHub(rt);
    const a = viewer('a');
    hub.attach(KEY, a.viewer);
    await hub.tickAll();
    const b = viewer('b');
    hub.attach(KEY, b.viewer);
    expect(b.states[0]?.surface).toBe('desktop');
    expect(b.frames).toHaveLength(1);
    rt.state = 'stopped';
    await hub.tickAll();
    expect(a.states.at(-1)?.status).toBe('waiting');
    expect(hub.isLive(KEY)).toBe(false);
  });

  it('captures soon after an agent op ends instead of waiting a full tick', async () => {
    const rt = createFakeDesktopRuntime();
    rt.state = 'running';
    const hub = makeHub(rt);
    const v = viewer('v1');
    hub.attach(KEY, v.viewer);
    await hub.tickAll();
    rt.png = Buffer.from('PNG-after-click');
    const end = beginDesktopAgentOp(KEY);
    end();
    await new Promise((r) => setTimeout(r, 20));
    await hub.tickAll();
    expect(v.frames.at(-1)?.data).toBe(Buffer.from('PNG-after-click').toString('base64'));
  });

  it('stays waiting when no desktop runtime is registered', async () => {
    const hub = makeHub(null);
    const v = viewer('v1');
    hub.attach(KEY, v.viewer);
    await hub.tickAll();
    expect(v.states.every((s) => s.status === 'waiting')).toBe(true);
  });

  it('stays live and keeps the frame when a running computer skips a capture', async () => {
    const rt = createFakeDesktopRuntime();
    rt.state = 'running';
    const hub = makeHub(rt);
    const v = viewer('v1');
    hub.attach(KEY, v.viewer);
    await hub.tickAll();
    rt.captureBusy = true;
    await hub.tickAll();
    expect(v.states.at(-1)?.status).toBe('live');
    expect(hub.isLive(KEY)).toBe(true);
    rt.captureBusy = false;
    const late = viewer('late');
    hub.attach(KEY, late.viewer);
    expect(late.frames).toHaveLength(1);
  });

  it('catches up a viewer that resumes showing the desktop on an unchanged screen', async () => {
    const rt = createFakeDesktopRuntime();
    rt.state = 'running';
    const hub = makeHub(rt);
    const a = viewer('a');
    let bShowing = false;
    const b = viewer('b', () => bShowing);
    hub.attach(KEY, a.viewer);
    hub.attach(KEY, b.viewer);
    await hub.tickAll();
    rt.png = Buffer.from('PNG-current');
    await hub.tickAll();
    expect(a.frames.at(-1)?.data).toBe(Buffer.from('PNG-current').toString('base64'));
    expect(b.frames).toHaveLength(0);

    bShowing = true;
    await hub.tickAll();
    expect(b.frames.map((f) => f.data)).toEqual([Buffer.from('PNG-current').toString('base64')]);
    // Already up to date: neither viewer gets the same frame twice.
    const aCount = a.frames.length;
    await hub.tickAll();
    expect(a.frames).toHaveLength(aCount);
    expect(b.frames).toHaveLength(1);
  });
});
