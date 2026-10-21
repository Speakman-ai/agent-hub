import { describe, it, expect, vi } from 'vitest';
import {
  createServerAgentSettingsBinding,
  createServerAgentSettingsStore,
  ServerAgentAccountChangedError,
  type ServerAgentSettings,
} from './serverAgentSettingsStore';

const settings = (name: string, instructions = ''): ServerAgentSettings => ({
  name,
  instructions,
  defaultName: 'Server Agent',
  effectiveName: name || 'Server Agent',
});

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

describe('createServerAgentSettingsStore', () => {
  it('serves settings only to the account they were loaded for', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(settings('A-agent', 'A secret'));
    const store = createServerAgentSettingsStore({ fetch, put: vi.fn() });
    await store.load('A');
    expect(store.get('A')?.instructions).toBe('A secret');
    expect(store.get('B')).toBeNull();
    expect(store.get(null)).toBeNull();
  });

  it('drops a pending response from the previous account after a switch', async () => {
    const forA = deferred<ServerAgentSettings>();
    const fetch = vi
      .fn()
      .mockReturnValueOnce(forA.promise)
      .mockResolvedValueOnce(settings('B-agent', 'B notes'));
    const store = createServerAgentSettingsStore({ fetch, put: vi.fn() });

    const pendingA = store.load('A');
    await store.load('B');
    expect(store.get('B')?.name).toBe('B-agent');

    // A's slow response lands after the switch and must not replace B's.
    forA.resolve(settings('A-agent', 'A secret'));
    expect(await pendingA).toBeNull();
    expect(store.get('B')?.instructions).toBe('B notes');
    expect(store.get('A')).toBeNull();
  });

  it('clears the previous account as soon as another becomes current', async () => {
    const forB = deferred<ServerAgentSettings>();
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(settings('A-agent', 'A secret'))
      .mockReturnValueOnce(forB.promise);
    const store = createServerAgentSettingsStore({ fetch, put: vi.fn() });
    await store.load('A');
    void store.load('B');
    expect(store.get('A')).toBeNull();
    expect(store.get('B')).toBeNull();
    forB.resolve(settings('B-agent'));
  });

  it("refuses to save a draft into another account's preferences", async () => {
    const put = vi.fn().mockResolvedValue(settings('x'));
    const fetch = vi.fn().mockResolvedValue(settings(''));
    const store = createServerAgentSettingsStore({ fetch, put });
    await store.load('A');
    await store.load('B');
    await expect(store.save('A', { name: 'x', instructions: 'A secret' })).rejects.toBeInstanceOf(
      ServerAgentAccountChangedError,
    );
    expect(put).not.toHaveBeenCalled();

    await store.save('B', { name: 'x' });
    expect(put).toHaveBeenCalledWith({ name: 'x' });
    expect(store.get('B')?.name).toBe('x');
  });

  it('does not cache a save that completes after the account changed', async () => {
    const saving = deferred<ServerAgentSettings>();
    const fetch = vi.fn().mockResolvedValue(settings(''));
    const store = createServerAgentSettingsStore({ fetch, put: () => saving.promise });
    await store.load('A');
    const pending = store.save('A', { name: 'A-agent' });
    await store.load('B');
    saving.resolve(settings('A-agent'));
    await pending;
    expect(store.get('B')?.name).toBe('');
    expect(store.get('A')).toBeNull();
  });

  it('records a failed load for its account, then clears it when a retry succeeds', async () => {
    const fetch = vi
      .fn()
      .mockRejectedValueOnce(new Error('Network down'))
      .mockResolvedValueOnce(settings('A-agent'));
    const store = createServerAgentSettingsStore({ fetch, put: vi.fn() });
    expect(await store.load('A')).toBeNull();
    expect(store.loadError('A')).toBe('Network down');
    expect(store.loadError('B')).toBeNull();

    await store.load('A');
    expect(store.loadError('A')).toBeNull();
    expect(store.get('A')?.name).toBe('A-agent');
  });

  it("does not report a previous account's load failure", async () => {
    let rejectA!: (e: Error) => void;
    const fetch = vi
      .fn()
      .mockReturnValueOnce(new Promise((_, rej) => (rejectA = rej)))
      .mockResolvedValueOnce(settings('B-agent'));
    const store = createServerAgentSettingsStore({ fetch, put: vi.fn() });
    const pendingA = store.load('A');
    await store.load('B');
    rejectA(new Error('A failed'));
    await pendingA;
    expect(store.loadError('A')).toBeNull();
    expect(store.loadError('B')).toBeNull();
  });

  it('drops the first A load when it resolves last after A -> B -> A', async () => {
    const firstA = deferred<ServerAgentSettings>();
    const fetch = vi
      .fn()
      .mockReturnValueOnce(firstA.promise)
      .mockResolvedValueOnce(settings('B-agent'))
      .mockResolvedValueOnce(settings('A-new', 'fresh'));
    const put = vi.fn().mockResolvedValue(settings('A-saved', 'newest'));
    const store = createServerAgentSettingsStore({ fetch, put });

    const pendingFirstA = store.load('A');
    await store.load('B');
    // Back on A: a fresh request, not the first visit's in-flight one.
    await store.load('A');
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(store.get('A')?.instructions).toBe('fresh');
    await store.save('A', { instructions: 'newest' });

    firstA.resolve(settings('A-old', 'obsolete'));
    expect(await pendingFirstA).toBeNull();
    expect(store.get('A')?.instructions).toBe('newest');
  });

  it('drops a save from the first A visit that completes after A -> B -> A', async () => {
    const saving = deferred<ServerAgentSettings>();
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(settings('A-agent', 'one'))
      .mockResolvedValueOnce(settings('B-agent'))
      .mockResolvedValueOnce(settings('A-agent', 'two'));
    const store = createServerAgentSettingsStore({ fetch, put: () => saving.promise });

    await store.load('A');
    const pendingSave = store.save('A', { instructions: 'stale save' });
    await store.load('B');
    await store.load('A');
    saving.resolve(settings('A-agent', 'stale save'));
    await pendingSave;
    expect(store.get('A')?.instructions).toBe('two');
  });

  it('drops a load failure from the first A visit that lands after A -> B -> A', async () => {
    let rejectFirstA!: (e: Error) => void;
    const fetch = vi
      .fn()
      .mockReturnValueOnce(new Promise((_, rej) => (rejectFirstA = rej)))
      .mockResolvedValueOnce(settings('B-agent'))
      .mockResolvedValueOnce(settings('A-agent', 'fresh'));
    const store = createServerAgentSettingsStore({ fetch, put: vi.fn() });

    const firstA = store.load('A');
    await store.load('B');
    await store.load('A');
    rejectFirstA(new Error('late failure'));
    expect(await firstA).toBeNull();
    expect(store.loadError('A')).toBeNull();
    expect(store.get('A')?.instructions).toBe('fresh');
  });
});

describe('createServerAgentSettingsBinding', () => {
  // Each "render" runs its effects immediately; enough to drive the binding.
  const hooks = {
    useSyncExternalStore: <T>(_subscribe: unknown, get: () => T) => get(),
    useEffect: (effect: () => void | (() => void)) => {
      effect();
    },
  };

  function setup() {
    const account = { key: 'A#1' as string | null };
    const fetch = vi.fn();
    const put = vi.fn();
    const binding = createServerAgentSettingsBinding({
      fetch,
      put,
      useAccountKey: () => account.key,
      hooks,
    });
    const flush = () => new Promise((r) => setTimeout(r, 0));
    return { account, fetch, put, binding, flush };
  }

  it('drops a save from before sign-out when the same user signs back in', async () => {
    const { account, fetch, put, binding, flush } = setup();
    const firstSave = deferred<ServerAgentSettings>();
    fetch
      .mockResolvedValueOnce(settings('A', 'one'))
      .mockResolvedValueOnce(settings('A', 'reloaded'));
    put.mockReturnValueOnce(firstSave.promise).mockResolvedValueOnce(settings('A', 'newer'));

    binding.useServerAgentSettings();
    await flush();
    expect(binding.useServerAgentSettings()?.instructions).toBe('one');
    const pending = binding.saveServerAgentSettings('A#1', { instructions: 'older' });
    // The same key on both sides of the sign-out: only observing the signed-out
    // state tells the two sessions apart.

    // Signed out: only the load-error hook renders, and nothing loads.
    account.key = null;
    binding.useServerAgentLoadError();
    // The same user signs in again.
    account.key = 'A#1';
    binding.useServerAgentSettings();
    await flush();
    expect(binding.useServerAgentSettings()?.instructions).toBe('reloaded');
    await binding.saveServerAgentSettings('A#1', { instructions: 'newer' });

    firstSave.resolve(settings('A', 'older'));
    await pending;
    expect(binding.useServerAgentSettings()?.instructions).toBe('newer');
    // The cache from before sign-out was not reused: settings were refetched.
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('invalidates on sign-out even when loading is disabled', async () => {
    const { account, fetch, put, binding, flush } = setup();
    const firstSave = deferred<ServerAgentSettings>();
    fetch.mockResolvedValue(settings('A', 'one'));
    put.mockReturnValueOnce(firstSave.promise);
    binding.useServerAgentSettings();
    await flush();
    const pending = binding.saveServerAgentSettings('A#1', { instructions: 'older' });

    account.key = null;
    expect(binding.useServerAgentSettings(false)).toBeNull();
    firstSave.resolve(settings('A', 'older'));
    await pending;

    // Even a key reused after sign-out does not see the first session's state.
    account.key = 'A#1';
    expect(binding.useServerAgentSettings(false)).toBeNull();
    await expect(binding.saveServerAgentSettings('A#2', {})).rejects.toBeInstanceOf(
      ServerAgentAccountChangedError,
    );
  });
});
