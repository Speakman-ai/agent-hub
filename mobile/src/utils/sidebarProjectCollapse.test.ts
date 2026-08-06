// @ts-nocheck
import { describe, it, expect, beforeEach, vi } from 'vitest';
// In-memory AsyncStorage mock, mirroring navGroupCollapse.test.ts.
// Must live above the module import below.
vi.mock('@react-native-async-storage/async-storage', () => {
  const store = new Map();
  return {
    default: {
      getItem: vi.fn(async (key: any) => (store.has(key) ? store.get(key) : null)),
      setItem: vi.fn(async (key: any, value: any) => {
        store.set(key, value);
      }),
      removeItem: vi.fn(async (key: any) => {
        store.delete(key);
      }),
      getAllKeys: vi.fn(async () => [...store.keys()]),
      multiRemove: vi.fn(async (keys: any[]) => {
        for (const key of keys) store.delete(key);
      }),
      clear: vi.fn(async () => {
        store.clear();
      }),
      _store: store,
    },
  };
});
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  COLLAPSED_PROJECTS_STORAGE_PREFIX,
  createCollapsedProjectsCacheSaver,
  currentCollapsedProjectsKey,
  loadCollapsedProjects,
  saveCollapsedProjects,
} from './sidebarProjectCollapse';
import { setToken, clearToken } from './auth';

const signIn = (userId: string) =>
  setToken({
    token: `tok-${userId}`,
    expiresAt: null,
    user: { id: userId, username: userId, email: null, role: 'Owner' },
  });

const keyFor = (userId: string) => `${COLLAPSED_PROJECTS_STORAGE_PREFIX}:${userId}`;

describe('mobile collapsed-projects cache', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    await AsyncStorage.clear();
    await clearToken();
    await signIn('user-a');
    vi.clearAllMocks();
  });

  it('round-trips a collapsed list', async () => {
    await saveCollapsedProjects(['alpha', 'beta']);
    expect(await loadCollapsedProjects()).toEqual(['alpha', 'beta']);
  });

  it('removes the key when nothing is collapsed', async () => {
    await saveCollapsedProjects(['alpha']);
    await saveCollapsedProjects([]);
    expect(await AsyncStorage.getItem(currentCollapsedProjectsKey())).toBeNull();
    expect(await loadCollapsedProjects()).toEqual([]);
  });

  it('returns an empty list for a malformed payload instead of throwing', async () => {
    await AsyncStorage.setItem(currentCollapsedProjectsKey(), 'not json');
    expect(await loadCollapsedProjects()).toEqual([]);
  });

  it('normalizes duplicate / blank entries on read', async () => {
    await AsyncStorage.setItem(
      currentCollapsedProjectsKey(),
      JSON.stringify(['  alpha  ', 'alpha', '', 3, 'beta']),
    );
    expect(await loadCollapsedProjects()).toEqual(['alpha', 'beta']);
  });

  it('swallows storage failures on both read and write', async () => {
    (AsyncStorage.getItem as any).mockRejectedValueOnce(new Error('storage down'));
    expect(await loadCollapsedProjects()).toEqual([]);
    (AsyncStorage.setItem as any).mockRejectedValueOnce(new Error('storage down'));
    await expect(saveCollapsedProjects(['alpha'])).resolves.toBeUndefined();
  });

  it('coalesces rapid writes so the final cache value wins', async () => {
    let releaseFirstWrite!: () => void;
    const firstWrite = new Promise<void>((resolve) => {
      releaseFirstWrite = resolve;
    });
    (AsyncStorage.setItem as any).mockImplementationOnce(() => firstWrite);

    const saver = createCollapsedProjectsCacheSaver();
    const first = saver.save(['alpha']);
    await Promise.resolve();
    const second = saver.save([]);

    releaseFirstWrite();
    await expect(Promise.all([first, second])).resolves.toEqual([undefined, undefined]);
    expect(AsyncStorage.setItem).toHaveBeenCalledTimes(1);
    expect(AsyncStorage.removeItem).toHaveBeenCalledWith(currentCollapsedProjectsKey());
  });

  it("does not let an old account's in-flight write prune the new account's cache", async () => {
    let releaseAccountARead!: (keys: string[]) => void;
    const accountARead = new Promise<string[]>((resolve) => {
      releaseAccountARead = resolve;
    });
    let releaseAccountAWrite!: () => void;
    const accountAWrite = new Promise<void>((resolve) => {
      releaseAccountAWrite = resolve;
    });
    const store = (AsyncStorage as any)._store as Map<string, string>;
    const accountAKey = keyFor('user-a');
    const accountBKey = keyFor('user-b');
    (AsyncStorage.setItem as any).mockImplementation(async (key: string, value: string) => {
      if (key === accountAKey) {
        await accountAWrite;
        store.set(key, value);
        return;
      }
      store.set(key, value);
    });
    (AsyncStorage.getAllKeys as any).mockImplementationOnce(() => accountARead);

    const accountASaver = createCollapsedProjectsCacheSaver();
    const accountASave = accountASaver.save(['alpha']);

    await signIn('user-b');
    await AsyncStorage.setItem(accountBKey, JSON.stringify(['beta']));
    store.set(accountAKey, JSON.stringify(['alpha']));
    releaseAccountARead([accountAKey, accountBKey]);
    releaseAccountAWrite();
    await accountASave;

    expect(await AsyncStorage.getItem(accountBKey)).toBe(JSON.stringify(['beta']));

    // Restore the default mock implementations for the following tests. The
    // old implementation would consume this deferred read and remove B.
    (AsyncStorage.getAllKeys as any).mockImplementation(async () => [...store.keys()]);
    (AsyncStorage.setItem as any).mockImplementation(async (key: string, value: string) => {
      store.set(key, value);
    });
  });

  it('scopes the cache per account', async () => {
    // Regression: a global key let the next person to sign in on this device
    // paint the previous user's collapsed projects.
    await saveCollapsedProjects(['alpha']);
    expect(currentCollapsedProjectsKey()).toBe(keyFor('user-a'));

    await signIn('user-b');
    expect(currentCollapsedProjectsKey()).toBe(keyFor('user-b'));
    expect(await loadCollapsedProjects()).toEqual([]);
  });

  it("prunes other accounts' buckets on write", async () => {
    await AsyncStorage.setItem(keyFor('user-b'), JSON.stringify(['beta']));
    // Pre-scoping unkeyed entries are reaped too.
    await AsyncStorage.setItem(COLLAPSED_PROJECTS_STORAGE_PREFIX, JSON.stringify(['legacy']));
    await AsyncStorage.setItem('agent-hub-nav-groups-collapsed', '{}');

    await saveCollapsedProjects(['alpha']);

    expect(await AsyncStorage.getItem(keyFor('user-b'))).toBeNull();
    expect(await AsyncStorage.getItem(COLLAPSED_PROJECTS_STORAGE_PREFIX)).toBeNull();
    expect(await loadCollapsedProjects()).toEqual(['alpha']);
    // …and it must not reap unrelated keys.
    expect(await AsyncStorage.getItem('agent-hub-nav-groups-collapsed')).toBe('{}');
  });

  it('falls back to an anonymous bucket when signed out (local-bundled)', async () => {
    await clearToken();
    expect(currentCollapsedProjectsKey()).toBe(keyFor('anonymous'));
    await saveCollapsedProjects(['alpha']);
    expect(await loadCollapsedProjects()).toEqual(['alpha']);
  });
});
