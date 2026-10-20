import { beforeEach, describe, expect, it, vi } from 'vitest';
import AsyncStorage from '@react-native-async-storage/async-storage';

vi.mock('@react-native-async-storage/async-storage', () => {
  const store = new Map<string, string>();
  return {
    default: {
      getItem: vi.fn(async (key: string) => store.get(key) ?? null),
      setItem: vi.fn(async (key: string, value: string) => {
        store.set(key, value);
      }),
      removeItem: vi.fn(async (key: string) => {
        store.delete(key);
      }),
      clear: vi.fn(async () => {
        store.clear();
      }),
    },
  };
});

const servers = [
  { id: 'old-a', name: 'Alpha', remoteUrl: 'https://a.test', apiKey: 'a-key' },
  { id: 'old-b', name: 'Beta', remoteUrl: 'https://b.test', apiKey: 'b-key' },
];

describe('Server connection upgrade compatibility', () => {
  beforeEach(async () => {
    vi.resetModules();
    await AsyncStorage.clear();
    await AsyncStorage.setItem(
      'agent-hub-orgs',
      JSON.stringify({ orgs: servers, activeOrgId: 'old-a' }),
    );
  });

  it('preserves saved IDs and credentials through switch, restart and sign-out', async () => {
    const orgs = await import('./orgs');
    const auth = await import('./auth');
    const config = await import('./config');
    await orgs.loadOrgs();
    await auth.setToken({ token: 'a-jwt', origin: 'https://a.test', user: { id: 'a-user' } });
    await auth.setToken({ token: 'b-jwt', origin: 'https://b.test', user: { id: 'b-user' } });
    await orgs.switchOrg('old-a');
    expect(auth.getToken()).toBe('a-jwt');
    await orgs.switchOrg('old-b');
    expect(auth.getToken()).toBe('b-jwt');
    expect(config.getApiBaseUrl()).toBe('https://b.test/api');
    expect(orgs.getActiveOrg()?.id).toBe('old-b');
    expect(JSON.parse((await AsyncStorage.getItem('agent-hub-orgs'))!)).toEqual({
      orgs: servers,
      activeOrgId: 'old-b',
    });

    vi.resetModules();
    const refreshed = await import('./orgs');
    await refreshed.migrateFromLegacy();
    expect(refreshed.getOrgs()).toEqual({ orgs: servers, activeOrgId: 'old-b' });
    await refreshed.switchOrg('old-b');
    const refreshedAuth = await import('./auth');
    expect(refreshedAuth.getToken()).toBe('b-jwt');
    await refreshedAuth.clearToken();
    expect(refreshedAuth.getToken()).toBeNull();
    await refreshed.switchOrg('old-a');
    expect(refreshedAuth.getToken()).toBe('a-jwt');
    expect(refreshed.getOrgs().orgs).toEqual(servers);
    const { pushSource } = await import('./serverPush');
    expect(
      pushSource({ hubServerUrl: 'https://b.test' }, refreshed.getOrgs().orgs, 'https://a.test'),
    ).toMatchObject({
      kind: 'other',
      server: { id: 'old-b', serverUrl: 'https://b.test', apiKey: 'b-key' },
    });
  });
});
