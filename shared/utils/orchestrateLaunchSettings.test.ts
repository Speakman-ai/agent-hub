import { describe, expect, it, vi } from 'vitest';
import {
  ORCHESTRATE_CANCELLED_KEY,
  createOrchestrateLaunchStore,
  type OrchestrateLaunchStorage,
} from './orchestrateLaunchSettings';

const useSyncExternalStore = (<T>(_s: unknown, get: () => T) => get()) as never;

function syncStorage(map = new Map<string, string>()): OrchestrateLaunchStorage {
  return { getItem: (k) => map.get(k) ?? null, setItem: (k, v) => void map.set(k, v) };
}

function asyncStorage(map = new Map<string, string>()): OrchestrateLaunchStorage {
  return {
    getItem: async (k) => map.get(k) ?? null,
    setItem: async (k, v) => {
      map.set(k, v);
    },
  };
}

async function settle() {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
}

describe('createOrchestrateLaunchStore with sync storage (web)', () => {
  it('sees a cancel saved by another store over the same storage at claim time', () => {
    const shared = new Map<string, string>();
    const tabA = createOrchestrateLaunchStore({
      storage: syncStorage(shared),
      useSyncExternalStore,
    });
    const tabB = createOrchestrateLaunchStore({
      storage: syncStorage(shared),
      useSyncExternalStore,
    });
    expect(tabB.isOrchestrateAutoStartCancelled('card')).toBe(false);
    tabA.cancelOrchestrateAutoStart('card');
    expect(tabB.markOrchestrateAutoStartFired('card')).toBe(false);
  });

  it('notifies on a storage event that brings a new cancel, and merges saves', () => {
    const shared = new Map<string, string>();
    const tabA = createOrchestrateLaunchStore({
      storage: syncStorage(shared),
      useSyncExternalStore,
    });
    const tabB = createOrchestrateLaunchStore({
      storage: syncStorage(shared),
      useSyncExternalStore,
    });
    tabB.isOrchestrateAutoStartCancelled('warm');
    const listener = vi.fn();
    tabB.subscribeOrchestrateAutoStart(listener);
    tabA.cancelOrchestrateAutoStart('a');
    tabB.handleOrchestrateStorageEvent(ORCHESTRATE_CANCELLED_KEY);
    expect(listener).toHaveBeenCalled();
    tabB.cancelOrchestrateAutoStart('b');
    expect(JSON.parse(shared.get(ORCHESTRATE_CANCELLED_KEY)!)).toEqual(['a', 'b']);
  });

  it('reads settings synchronously and drops them on a settings storage event', () => {
    const shared = new Map<string, string>();
    const tabA = createOrchestrateLaunchStore({
      storage: syncStorage(shared),
      useSyncExternalStore,
    });
    const tabB = createOrchestrateLaunchStore({
      storage: syncStorage(shared),
      useSyncExternalStore,
    });
    tabA.setOrchestrateLaunchSettings('chat', { mode: 'push', autoStart: true });
    expect(tabB.getOrchestrateLaunchSettings('chat')).toEqual({ mode: 'push', autoStart: true });
    tabA.setOrchestrateLaunchSettings('chat', { autoStart: false });
    tabB.handleOrchestrateStorageEvent('agenthub:orchestrate-launch:chat');
    expect(tabB.getOrchestrateLaunchSettings('chat').autoStart).toBe(false);
  });
});

describe('createOrchestrateLaunchStore with async storage (mobile)', () => {
  it('blocks a card until saved cancels load, then honors a saved cancel', async () => {
    const saved = new Map<string, string>([[ORCHESTRATE_CANCELLED_KEY, '["old"]']]);
    const store = createOrchestrateLaunchStore({
      storage: asyncStorage(saved),
      useSyncExternalStore,
    });
    expect(store.markOrchestrateAutoStartFired('new')).toBe(false);
    await settle();
    expect(store.isOrchestrateAutoStartCancelled('old')).toBe(true);
    expect(store.markOrchestrateAutoStartFired('new')).toBe(true);
  });

  it('saves a cancel made while loading together with the saved ones', async () => {
    const saved = new Map<string, string>([[ORCHESTRATE_CANCELLED_KEY, '["old"]']]);
    const store = createOrchestrateLaunchStore({
      storage: asyncStorage(saved),
      useSyncExternalStore,
    });
    store.cancelOrchestrateAutoStart('early');
    await settle();
    expect(JSON.parse(saved.get(ORCHESTRATE_CANCELLED_KEY)!)).toEqual(['old', 'early']);
  });

  it('serves defaults until saved settings arrive, then notifies', async () => {
    const saved = new Map<string, string>([
      ['agenthub:orchestrate-launch:chat', JSON.stringify({ mode: 'merge', autoStart: true })],
    ]);
    const store = createOrchestrateLaunchStore({
      storage: asyncStorage(saved),
      useSyncExternalStore,
    });
    const listener = vi.fn();
    store.subscribeOrchestrateLaunchSettings('chat', listener);
    expect(store.getOrchestrateLaunchSettings('chat')).toEqual({
      mode: 'manual',
      autoStart: false,
    });
    await settle();
    expect(listener).toHaveBeenCalled();
    expect(store.getOrchestrateLaunchSettings('chat')).toEqual({ mode: 'merge', autoStart: true });
  });
});
