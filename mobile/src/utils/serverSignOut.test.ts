import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@react-native-async-storage/async-storage', () => {
  const store = new Map<string, string>();
  return {
    default: {
      getItem: vi.fn(async (k: string) => store.get(k) ?? null),
      setItem: vi.fn(async (k: string, v: string) => {
        store.set(k, v);
      }),
      removeItem: vi.fn(async (k: string) => {
        store.delete(k);
      }),
      clear: vi.fn(async () => store.clear()),
    },
  };
});

import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  activateAuthForServer,
  clearToken,
  getToken,
  loginTokenForServer,
  reloadAuthVault,
  setToken,
} from './auth';
import { createPushRegistrar } from './pushRegistrar';
import { signOutOfServer } from './serverSignOut';

const A = 'https://a.test';
const B = 'https://b.test';
const ORGS = [
  { id: 'a', remoteUrl: A },
  { id: 'b', remoteUrl: B },
];

const flush = () => new Promise((r) => setTimeout(r, 0));

async function setup() {
  await setToken({ token: 'tok-a', origin: A });
  await setToken({ token: 'tok-b', origin: B });
  await activateAuthForServer(A);
  let active = A;

  // Push requests: held until released, so a switch can happen mid-sign-out.
  const pushCalls: string[] = [];
  const held: Array<() => void> = [];
  const registrar = createPushRegistrar({
    deps: {
      loginTokenFor: loginTokenForServer,
      fetch: (url, init) => {
        pushCalls.push(`${init.method} ${url} ${init.headers.Authorization ?? ''}`.trim());
        return new Promise((resolve) => held.push(() => resolve({ ok: true, status: 200 })));
      },
    },
    getOrgs: () => ORGS,
    log: () => {},
  });
  return {
    registrar,
    pushCalls,
    releaseAll: async () => {
      await flush();
      while (held.length) held.shift()!();
      await flush();
    },
    active: () => active,
    switchTo: async (url: string) => {
      active = url;
      await activateAuthForServer(url);
    },
  };
}

describe('signing out while switching servers', () => {
  const logoutFetch = vi.fn(async () => ({ ok: true, status: 200 }));
  const realFetch = globalThis.fetch;

  beforeEach(async () => {
    await clearToken();
    await (AsyncStorage as any).clear();
    await reloadAuthVault();
    logoutFetch.mockClear();
    globalThis.fetch = logoutFetch as any;
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it('keeps B signed in and active, and sends A’s token only to A', async () => {
    const h = await setup();
    // Register the phone first so sign-out has an unregister to wait on.
    const launch = h.registrar.setDevice('T', 'ios');
    await h.releaseAll();
    await launch;
    h.pushCalls.length = 0;

    const onSignedOutWhileActive = vi.fn();
    const signingOut = signOutOfServer({
      serverUrl: A,
      registrar: h.registrar,
      currentServerUrl: h.active,
      onSignedOutWhileActive,
    });
    await flush();
    expect(h.pushCalls).toEqual([`DELETE ${A}/api/devices/T Bearer tok-a`]);

    // The user switches to B while A's DELETE is still in flight.
    await h.switchTo(B);
    expect(getToken()).toBe('tok-b');

    await h.releaseAll();
    await signingOut;

    expect(getToken()).toBe('tok-b');
    expect(await loginTokenForServer(B)).toBe('tok-b');
    expect(await loginTokenForServer(A)).toBeNull();
    expect(logoutFetch).toHaveBeenCalledTimes(1);
    expect(logoutFetch.mock.calls[0]).toMatchObject([
      `${A}/api/auth/logout`,
      { method: 'POST', headers: { Authorization: 'Bearer tok-a' } },
    ]);
    // B is active, so A's sign-out must not raise the login gate over it.
    expect(onSignedOutWhileActive).not.toHaveBeenCalled();
  });

  it('without a switch, clears A and resets the active UI', async () => {
    const h = await setup();
    const launch = h.registrar.setDevice('T', 'ios');
    await h.releaseAll();
    await launch;

    const onSignedOutWhileActive = vi.fn();
    const signingOut = signOutOfServer({
      serverUrl: A,
      registrar: h.registrar,
      currentServerUrl: h.active,
      onSignedOutWhileActive,
    });
    await h.releaseAll();
    await signingOut;
    expect(getToken()).toBeNull();
    expect(await loginTokenForServer(A)).toBeNull();
    expect(await loginTokenForServer(B)).toBe('tok-b');
    expect(onSignedOutWhileActive).toHaveBeenCalledTimes(1);
  });

  it('a newer sign-in to A made during the sign-out is not undone', async () => {
    const h = await setup();
    const launch = h.registrar.setDevice('T', 'ios');
    await h.releaseAll();
    await launch;

    const onSignedOutWhileActive = vi.fn();
    const signingOut = signOutOfServer({
      serverUrl: A,
      registrar: h.registrar,
      currentServerUrl: h.active,
      onSignedOutWhileActive,
    });
    await flush();
    await setToken({ token: 'tok-a2', origin: A });
    await h.releaseAll();
    expect(await signingOut).toBe(false);
    expect(await loginTokenForServer(A)).toBe('tok-a2');
    expect(getToken()).toBe('tok-a2');
    // The newer login owns A now: the UI must not drop to the login screen.
    expect(onSignedOutWhileActive).not.toHaveBeenCalled();
  });
});
