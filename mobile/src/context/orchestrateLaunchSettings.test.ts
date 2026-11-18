import { beforeEach, describe, expect, it, vi } from 'vitest';

const store = vi.hoisted(() => new Map<string, string>());
vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: vi.fn(async (key: string) => store.get(key) ?? null),
    setItem: vi.fn(async (key: string, value: string) => {
      store.set(key, value);
    }),
  },
}));

const {
  cancelOrchestrateAutoStart,
  isOrchestrateAutoStartCancelled,
  markOrchestrateAutoStartFired,
  resetOrchestrateLaunchStateForTests,
  subscribeOrchestrateAutoStart,
} = await import('./orchestrateLaunchSettings');

async function settle() {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
}

beforeEach(() => {
  store.clear();
  resetOrchestrateLaunchStateForTests();
});

describe('orchestrate auto start claims (mobile)', () => {
  it('refuses to fire a cancelled card and notifies subscribers of the cancel', async () => {
    isOrchestrateAutoStartCancelled('card-2');
    await settle();
    const listener = vi.fn();
    const stop = subscribeOrchestrateAutoStart(listener);
    cancelOrchestrateAutoStart('card-1');
    expect(listener).toHaveBeenCalled();
    expect(markOrchestrateAutoStartFired('card-1')).toBe(false);
    expect(markOrchestrateAutoStartFired('card-2')).toBe(true);
    expect(markOrchestrateAutoStartFired('card-2')).toBe(false);
    stop();
  });

  it('blocks auto start until saved cancels have loaded', async () => {
    expect(markOrchestrateAutoStartFired('card-2')).toBe(false);
    await settle();
    expect(markOrchestrateAutoStartFired('card-2')).toBe(true);
  });

  it('keeps a cancel after the app is reopened', async () => {
    isOrchestrateAutoStartCancelled('warm-up');
    await settle();
    cancelOrchestrateAutoStart('card-1');
    await settle();
    // App restart: memory is gone, AsyncStorage is not.
    resetOrchestrateLaunchStateForTests();
    expect(isOrchestrateAutoStartCancelled('card-1')).toBe(true);
    await settle();
    expect(isOrchestrateAutoStartCancelled('card-1')).toBe(true);
    expect(markOrchestrateAutoStartFired('card-1')).toBe(false);
    expect(isOrchestrateAutoStartCancelled('card-2')).toBe(false);
  });

  it('saves a cancel made before saved cancels finished loading', async () => {
    cancelOrchestrateAutoStart('early');
    await settle();
    resetOrchestrateLaunchStateForTests();
    isOrchestrateAutoStartCancelled('early');
    await settle();
    expect(isOrchestrateAutoStartCancelled('early')).toBe(true);
    expect(isOrchestrateAutoStartCancelled('other')).toBe(false);
  });
});
