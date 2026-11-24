import { describe, expect, it, vi } from 'vitest';
import { createOrchestrateLaunchClient } from './orchestrateLaunchClient.js';

const useSync = ((_s: unknown, get: () => unknown) => get()) as never;

function setup(clock = { now: 1_000 }) {
  const api = {
    getOrchestrateLaunch: vi.fn(),
    putOrchestrateLaunch: vi.fn(),
    cancelOrchestrateAutoStart: vi.fn().mockResolvedValue({}),
  };
  const client = createOrchestrateLaunchClient({
    api: api as never,
    useSyncExternalStore: useSync,
    now: () => clock.now,
  });
  return { api, client, clock };
}

describe('createOrchestrateLaunchClient', () => {
  it('mirrors a load: settings, started cards, cancels and countdowns', async () => {
    const { api, client } = setup();
    api.getOrchestrateLaunch.mockResolvedValue({
      settings: { mode: 'push', autoStart: true, configured: true, revision: 3 },
      launched: [{ dispatchKey: 'k1', sessionId: 's1', agentId: 'a', name: 'n', mode: 'push' }],
      cancelled: ['k2'],
      pending: [{ dispatchKey: 'k3', remainingMs: 12_000 }],
    });
    await client.load('chat');
    expect(client.getSettings('chat')).toEqual({ mode: 'push', autoStart: true, revision: 3 });
    expect(client.useStarted('k1')).toMatchObject({ sessionId: 's1' });
    expect(client.useCancelled('k2')).toBe(true);
    expect(client.getDeadline('k3')).toBe(13_000);
  });

  it('shares one request between concurrent loads of a chat', async () => {
    const { api, client } = setup();
    let release!: (v: unknown) => void;
    api.getOrchestrateLaunch.mockReturnValue(new Promise((r) => (release = r)));
    const a = client.load('chat');
    const b = client.load('chat');
    expect(api.getOrchestrateLaunch).toHaveBeenCalledTimes(1);
    release({ settings: { mode: 'manual', autoStart: false, revision: 0 } });
    await Promise.all([a, b]);
  });

  it('ignores a server value older than the one it holds, wherever it came from', async () => {
    const { api, client } = setup();
    api.putOrchestrateLaunch.mockResolvedValue({
      settings: { mode: 'manual', autoStart: false, revision: 5 },
    });
    await client.save('chat', { autoStart: false });
    // A load answered before the save, and an older broadcast, arrive late.
    api.getOrchestrateLaunch.mockResolvedValue({
      settings: { mode: 'manual', autoStart: true, revision: 4 },
    });
    await client.load('chat');
    client.handleEvent({
      type: 'orchestrate_launch_updated',
      sessionId: 'chat',
      settings: { mode: 'manual', autoStart: true, revision: 3 },
    });
    expect(client.getSettings('chat')?.autoStart).toBe(false);
    client.handleEvent({
      type: 'orchestrate_launch_updated',
      sessionId: 'chat',
      settings: { mode: 'merge', autoStart: true, revision: 6 },
    });
    expect(client.getSettings('chat')).toEqual({ mode: 'merge', autoStart: true, revision: 6 });
  });

  it('passes a failed save or cancel back to the caller and changes nothing', async () => {
    const { api, client } = setup();
    api.putOrchestrateLaunch.mockRejectedValue(new Error('offline'));
    api.cancelOrchestrateAutoStart.mockRejectedValue(new Error('offline'));
    await expect(client.save('chat', { autoStart: true })).rejects.toThrow('offline');
    expect(client.getSettings('chat')).toBeNull();
    await expect(
      client.cancel('chat', { messageId: 7, forwardId: 'f', occurrence: 0 }),
    ).rejects.toThrow('offline');
    expect(client.useCancelled('session-forward:chat:7:f:0')).toBe(false);
  });

  it('marks a confirmed cancel and drops its countdown', async () => {
    const { client } = setup();
    client.handleEvent({
      type: 'orchestrate_auto_start_scheduled',
      dispatchKey: 'session-forward:chat:7:f:0',
      remainingMs: 30_000,
    });
    await client.cancel('chat', { messageId: 7, forwardId: 'f', occurrence: 0 });
    expect(client.useCancelled('session-forward:chat:7:f:0')).toBe(true);
    expect(client.getDeadline('session-forward:chat:7:f:0')).toBeNull();
    // A later schedule for a cancelled or started card is ignored.
    client.handleEvent({
      type: 'orchestrate_auto_start_scheduled',
      dispatchKey: 'session-forward:chat:7:f:0',
      remainingMs: 30_000,
    });
    expect(client.getDeadline('session-forward:chat:7:f:0')).toBeNull();
  });

  it('tracks whether a chat is in Orchestrate', () => {
    const { client } = setup();
    client.setSessionActive('chat', true);
    expect(client.useSessionActive('chat')).toBe(true);
    client.setSessionActive('chat', false);
    expect(client.useSessionActive('chat')).toBe(false);
  });

  it('leaves countdowns to their own events: a settings change alone drops none', () => {
    const { client } = setup();
    const key = 'session-forward:chat:1:a:0';
    client.handleEvent({
      type: 'orchestrate_auto_start_scheduled',
      dispatchKey: key,
      remainingMs: 30_000,
    });
    client.handleEvent({
      type: 'orchestrate_launch_updated',
      sessionId: 'chat',
      settings: { mode: 'push', autoStart: false, revision: 2 },
    });
    expect(client.getDeadline(key)).not.toBeNull();
    // Turning Auto start off reaches clients as the server's ended event per card.
    client.handleEvent({
      type: 'orchestrate_auto_start_ended',
      sessionId: 'chat',
      dispatchKey: key,
    });
    expect(client.getDeadline(key)).toBeNull();
  });

  it('drops a countdown the server ended or a press started', () => {
    const { client } = setup();
    client.handleEvent({
      type: 'orchestrate_auto_start_scheduled',
      dispatchKey: 'k1',
      remainingMs: 30_000,
    });
    client.handleEvent({
      type: 'orchestrate_auto_start_scheduled',
      dispatchKey: 'k2',
      remainingMs: 30_000,
    });
    client.handleEvent({ type: 'orchestrate_auto_start_ended', dispatchKey: 'k1' });
    client.handleEvent({
      type: 'session_forward_started',
      dispatchKey: 'k2',
      started: { sessionId: 's', agentId: 'a', name: 'n', mode: 'manual' },
    });
    expect(client.getDeadline('k1')).toBeNull();
    expect(client.getDeadline('k2')).toBeNull();
    expect(client.useStarted('k2')).toMatchObject({ sessionId: 's' });
  });

  it("replaces the chat's countdowns with the server's list on load", async () => {
    const { api, client } = setup();
    client.handleEvent({
      type: 'orchestrate_auto_start_scheduled',
      dispatchKey: 'session-forward:chat:1:gone:0',
      remainingMs: 30_000,
    });
    api.getOrchestrateLaunch.mockResolvedValue({
      settings: { mode: 'manual', autoStart: true, revision: 1 },
      pending: [{ dispatchKey: 'session-forward:chat:2:kept:0', remainingMs: 5_000 }],
    });
    await client.load('chat');
    expect(client.getDeadline('session-forward:chat:1:gone:0')).toBeNull();
    expect(client.getDeadline('session-forward:chat:2:kept:0')).toBe(6_000);
  });

  describe('a load answered before events that arrive first', () => {
    const key = 'session-forward:chat:7:a:0';
    function deferredLoad(snapshot: Record<string, unknown>) {
      const { api, client } = setup();
      let release!: () => void;
      api.getOrchestrateLaunch.mockReturnValue(
        new Promise((resolve) => {
          release = () => resolve(snapshot);
        }),
      );
      return { client, run: () => client.load('chat'), release: () => release() };
    }

    it('does not restore a countdown that Auto start off ended meanwhile', async () => {
      const { client, run, release } = deferredLoad({
        settings: { mode: 'manual', autoStart: true, revision: 1 },
        pending: [{ dispatchKey: key, remainingMs: 25_000 }],
      });
      client.handleEvent({
        type: 'orchestrate_auto_start_scheduled',
        dispatchKey: key,
        remainingMs: 30_000,
      });
      const loading = run();
      // Auto start is turned off and the server ends the countdown.
      client.handleEvent({
        type: 'orchestrate_launch_updated',
        sessionId: 'chat',
        settings: { mode: 'manual', autoStart: false, revision: 2 },
      });
      client.handleEvent({
        type: 'orchestrate_auto_start_ended',
        sessionId: 'chat',
        dispatchKey: key,
      });
      release();
      await loading;
      expect(client.getDeadline(key)).toBeNull();
      expect(client.getSettings('chat')?.autoStart).toBe(false);
    });

    it('does not restore a countdown the server ended meanwhile', async () => {
      const { client, run, release } = deferredLoad({
        settings: { mode: 'manual', autoStart: true, revision: 1 },
        pending: [{ dispatchKey: key, remainingMs: 25_000 }],
      });
      const loading = run();
      client.handleEvent({
        type: 'orchestrate_auto_start_ended',
        sessionId: 'chat',
        dispatchKey: key,
      });
      release();
      await loading;
      expect(client.getDeadline(key)).toBeNull();
    });

    it('keeps a countdown scheduled meanwhile that an older empty answer lacks', async () => {
      const { client, run, release } = deferredLoad({
        settings: { mode: 'manual', autoStart: true, revision: 1 },
        pending: [],
      });
      const loading = run();
      client.handleEvent({
        type: 'orchestrate_auto_start_scheduled',
        sessionId: 'chat',
        dispatchKey: key,
        remainingMs: 30_000,
      });
      release();
      await loading;
      expect(client.getDeadline(key)).toBe(31_000);
    });

    it('keeps a loaded countdown when only the Default build changes during the load', async () => {
      const { client, run, release } = deferredLoad({
        settings: { mode: 'manual', autoStart: true, revision: 1 },
        pending: [{ dispatchKey: key, remainingMs: 25_000 }],
      });
      const loading = run();
      client.handleEvent({
        type: 'orchestrate_launch_updated',
        sessionId: 'chat',
        settings: { mode: 'merge', autoStart: true, revision: 2 },
      });
      release();
      await loading;
      expect(client.getDeadline(key)).toBe(26_000);
      expect(client.getSettings('chat')).toMatchObject({ mode: 'merge', revision: 2 });
    });

    it('still settles countdowns no event touched', async () => {
      const stale = 'session-forward:chat:1:stale:0';
      const { client, run, release } = deferredLoad({
        settings: { mode: 'manual', autoStart: true, revision: 1 },
        pending: [{ dispatchKey: key, remainingMs: 5_000 }],
      });
      client.handleEvent({
        type: 'orchestrate_auto_start_scheduled',
        dispatchKey: stale,
        remainingMs: 30_000,
      });
      const loading = run();
      release();
      await loading;
      expect(client.getDeadline(stale)).toBeNull();
      expect(client.getDeadline(key)).toBe(6_000);
    });
  });

  describe('refreshAll after a reconnect', () => {
    const key = 'session-forward:chat:7:a:0';

    it('picks up a start, a cancel and a settings change missed while disconnected', async () => {
      const { api, client } = setup();
      client.setSessionActive('chat', true);
      client.handleEvent({
        type: 'orchestrate_launch_updated',
        sessionId: 'chat',
        settings: { mode: 'manual', autoStart: true, revision: 1 },
      });
      client.handleEvent({
        type: 'orchestrate_auto_start_scheduled',
        dispatchKey: key,
        remainingMs: 30_000,
      });
      client.handleEvent({
        type: 'orchestrate_auto_start_scheduled',
        dispatchKey: 'session-forward:chat:8:b:0',
        remainingMs: 30_000,
      });
      // The socket drops; the server starts one card, a device cancels the
      // other and changes the build. No events reach this client.
      api.getOrchestrateLaunch.mockResolvedValue({
        settings: { mode: 'merge', autoStart: true, revision: 2 },
        launched: [{ dispatchKey: key, sessionId: 's1', agentId: 'a', name: 'n', mode: 'merge' }],
        cancelled: ['session-forward:chat:8:b:0'],
        pending: [],
      });
      await client.refreshAll();
      expect(api.getOrchestrateLaunch).toHaveBeenCalledWith('chat');
      expect(client.getDeadline(key)).toBeNull();
      expect(client.useStarted(key)).toMatchObject({ sessionId: 's1' });
      expect(client.useCancelled('session-forward:chat:8:b:0')).toBe(true);
      expect(client.getSettings('chat')?.mode).toBe('merge');
    });

    it('loads again after a load that was already in flight at the reconnect', async () => {
      const { api, client } = setup();
      let releaseOld!: (v: unknown) => void;
      api.getOrchestrateLaunch
        .mockReturnValueOnce(new Promise((r) => (releaseOld = r)))
        .mockResolvedValue({ settings: { mode: 'manual', autoStart: false, revision: 3 } });
      const old = client.load('chat');
      const refreshed = client.refreshAll();
      releaseOld({ settings: { mode: 'manual', autoStart: true, revision: 2 } });
      await Promise.all([old, refreshed]);
      expect(api.getOrchestrateLaunch).toHaveBeenCalledTimes(2);
      expect(client.getSettings('chat')).toMatchObject({ autoStart: false, revision: 3 });
    });

    it('does nothing for a client that holds no launch state', async () => {
      const { api, client } = setup();
      await client.refreshAll();
      expect(api.getOrchestrateLaunch).not.toHaveBeenCalled();
    });
  });
});
