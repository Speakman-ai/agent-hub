import { describe, it, expect, vi } from 'vitest';

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: vi.fn(async () => null),
    setItem: vi.fn(async () => {}),
    removeItem: vi.fn(async () => {}),
  },
}));

import { createPushRegistrar } from './pushRegistrar';
import type { ServerPushDeps } from './serverPush';

type Call = { url: string; method: string; auth: string | undefined };

function harness(orgs: any[], logins: Record<string, string> = {}) {
  const calls: Call[] = [];
  const down = new Set<string>();
  const state = { orgs, logins: { ...logins } };
  const deps: ServerPushDeps = {
    loginTokenFor: async (url) => state.logins[url] ?? null,
    fetch: async (url, init) => {
      calls.push({ url, method: init.method, auth: init.headers.Authorization });
      if ([...down].some((d) => url.startsWith(d))) throw new Error('unreachable');
      return { ok: true, status: 200 };
    },
  };
  const registrar = createPushRegistrar({ deps, getOrgs: () => state.orgs, log: () => {} });
  return { registrar, calls, down, state };
}

const ORGS = [
  { id: 'a', remoteUrl: 'https://one.test' },
  { id: 'b', remoteUrl: 'https://two.test' },
];

describe('push registrar', () => {
  it('registers with every saved server once the device token is known', async () => {
    const h = harness(ORGS);
    await h.registrar.syncAll();
    expect(h.calls).toHaveLength(0);
    await h.registrar.setDevice('T', 'ios');
    expect(h.calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      'POST https://one.test/api/devices',
      'POST https://two.test/api/devices',
    ]);
  });

  it('switching to a server that was unreachable at launch registers it then', async () => {
    const h = harness(ORGS);
    h.down.add('https://two.test');
    const launch = await h.registrar.setDevice('T', 'ios');
    expect(launch.map((r) => r.ok)).toEqual([true, false]);

    h.down.clear();
    h.calls.length = 0;
    const onSwitch = await h.registrar.syncServer('https://two.test/');
    expect(onSwitch).toMatchObject([{ serverUrl: 'https://two.test', ok: true, status: 200 }]);
    expect(h.calls.map((c) => c.url)).toEqual(['https://two.test/api/devices']);
  });

  it('signing in registers with that server using the new login', async () => {
    const h = harness(ORGS);
    await h.registrar.setDevice('T', 'ios');
    h.calls.length = 0;
    h.state.logins['https://one.test'] = 'jwt-new';
    await h.registrar.syncServer('https://one.test');
    expect(h.calls).toEqual([
      { url: 'https://one.test/api/devices', method: 'POST', auth: 'Bearer jwt-new' },
    ]);
  });

  it('does nothing for a server that is not saved', async () => {
    const h = harness(ORGS);
    await h.registrar.setDevice('T', 'ios');
    h.calls.length = 0;
    expect(await h.registrar.syncServer('https://other.test')).toEqual([]);
    expect(await h.registrar.syncServer('')).toEqual([]);
    expect(h.calls).toHaveLength(0);
  });

  it('forgetting an entry keeps the registration while another entry shares its server', async () => {
    const shared = [...ORGS, { id: 'a2', remoteUrl: 'https://ONE.test/' }];
    const h = harness(shared);
    await h.registrar.setDevice('T', 'ios');
    h.calls.length = 0;
    const removeA = vi.fn().mockResolvedValue(undefined);
    expect(await h.registrar.forget(shared[0], removeA)).toBe(false);
    expect(removeA).toHaveBeenCalledTimes(1);
    expect(h.calls).toHaveLength(0);
    expect(await h.registrar.forget(shared[1], async () => {})).toBe(true);
    expect(h.calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      'DELETE https://two.test/api/devices/T',
    ]);
  });

  it('forget never throws when the server is unreachable', async () => {
    const h = harness(ORGS);
    await h.registrar.setDevice('T', 'ios');
    h.down.add('https://two.test');
    const remove = vi.fn().mockResolvedValue(undefined);
    await expect(h.registrar.forget(ORGS[1], remove)).resolves.toBe(false);
    expect(remove).toHaveBeenCalledTimes(1);
  });

  describe('sign-out', () => {
    it('unregisters with the login before it is cleared, then clears it', async () => {
      const h = harness(ORGS, { 'https://one.test': 'jwt-one' });
      await h.registrar.setDevice('T', 'ios');
      h.calls.length = 0;
      const order: string[] = [];
      await h.registrar.signOut('https://one.test', async () => {
        order.push(`clear after ${h.calls.length} call(s)`);
        delete h.state.logins['https://one.test'];
      });
      expect(h.calls).toEqual([
        { url: 'https://one.test/api/devices/T', method: 'DELETE', auth: 'Bearer jwt-one' },
      ]);
      expect(order).toEqual(['clear after 1 call(s)']);
    });

    it('still signs out when the server cannot be reached', async () => {
      const h = harness(ORGS, { 'https://one.test': 'jwt-one' });
      await h.registrar.setDevice('T', 'ios');
      h.down.add('https://one.test');
      const clearLogin = vi.fn().mockResolvedValue(undefined);
      await h.registrar.signOut('https://one.test', clearLogin);
      expect(clearLogin).toHaveBeenCalledTimes(1);
    });

    it('still signs out when the credential lookup itself throws', async () => {
      const clearLogin = vi.fn().mockResolvedValue(undefined);
      const registrar = createPushRegistrar({
        deps: {
          loginTokenFor: async () => {
            throw new Error('vault broken');
          },
          fetch: async () => {
            throw new Error('boom');
          },
        },
        getOrgs: () => ORGS,
        log: () => {},
      });
      await registrar.setDevice('T', 'ios');
      await registrar.signOut('https://one.test', clearLogin);
      expect(clearLogin).toHaveBeenCalledTimes(1);
    });

    it('signs out without a network call when the phone has no push token', async () => {
      const h = harness(ORGS);
      const clearLogin = vi.fn().mockResolvedValue(undefined);
      await h.registrar.signOut('https://one.test', clearLogin);
      expect(h.calls).toHaveLength(0);
      expect(clearLogin).toHaveBeenCalledTimes(1);
    });
  });
});

/** fetch whose responses are released by hand, to force interleavings. */
function heldNetwork(orgs: any[], logins: Record<string, string> = {}, timeoutMs?: number) {
  const state = { orgs: [...orgs], logins: { ...logins } };
  const sent: string[] = [];
  const pending: Array<{ label: string; release: () => void }> = [];
  const deps: ServerPushDeps = {
    timeoutMs,
    loginTokenFor: async (url) => state.logins[url] ?? null,
    fetch: (url, init) => {
      const label = `${init.method} ${url}${init.headers.Authorization ? ' (signed in)' : ''}`;
      sent.push(label);
      return new Promise((resolve) => {
        pending.push({ label, release: () => resolve({ ok: true, status: 200 }) });
      });
    },
  };
  const registrar = createPushRegistrar({ deps, getOrgs: () => state.orgs, log: () => {} });
  const flush = () => new Promise((r) => setTimeout(r, 0));
  const releaseNext = async () => {
    await flush();
    const next = pending.shift();
    if (!next) throw new Error('nothing in flight');
    next.release();
    await flush();
  };
  return { registrar, state, sent, pending, flush, releaseNext };
}

describe('push registrar ordering', () => {
  it('a DELETE for a removed server waits for an in-flight registration and is the last request', async () => {
    const n = heldNetwork(ORGS, { 'https://two.test': 'jwt-two' });
    const launch = n.registrar.setDevice('T', 'ios');
    await n.flush();
    expect(n.sent).toEqual([
      'POST https://one.test/api/devices',
      'POST https://two.test/api/devices (signed in)',
    ]);

    // User deletes two.test while its registration is still in flight.
    const removing = n.registrar.forget(ORGS[1], async () => {
      n.state.orgs = n.state.orgs.filter((o) => o.id !== 'b');
    });
    // A switch elsewhere asks to re-register two.test meanwhile.
    const staleSync = n.registrar.syncServer('https://two.test');
    await n.flush();
    expect(n.sent.filter((s) => s.startsWith('DELETE'))).toEqual([]);

    await n.releaseNext(); // one.test POST
    await n.releaseNext(); // two.test POST finishes first...
    expect(n.sent.at(-1)).toBe('DELETE https://two.test/api/devices/T (signed in)');
    await n.releaseNext(); // ...then the DELETE
    await Promise.all([launch, removing, staleSync]);

    // The re-registration queued during removal saw the server gone.
    expect(n.sent.filter((s) => s.includes('two.test'))).toEqual([
      'POST https://two.test/api/devices (signed in)',
      'DELETE https://two.test/api/devices/T (signed in)',
    ]);
    expect(n.pending).toHaveLength(0);
  });

  it('sign-out waits for an in-flight registration, and nothing registers afterwards', async () => {
    const n = heldNetwork(ORGS.slice(0, 1), { 'https://one.test': 'jwt-one' });
    const launch = n.registrar.setDevice('T', 'ios');
    const signingOut = n.registrar.signOut('https://one.test', async () => {
      delete n.state.logins['https://one.test'];
    });
    const afterSwitch = n.registrar.syncServer('https://one.test');
    await n.flush();
    expect(n.sent).toEqual(['POST https://one.test/api/devices (signed in)']);

    await n.releaseNext();
    expect(n.sent.at(-1)).toBe('DELETE https://one.test/api/devices/T (signed in)');
    await n.releaseNext();
    await Promise.all([launch, signingOut, afterSwitch]);
    // The DELETE is the last thing this server ever hears from the phone.
    expect(n.sent.at(-1)).toBe('DELETE https://one.test/api/devices/T (signed in)');
    expect(n.pending).toHaveLength(0);
  });

  it('other servers are not held up by one server’s queue', async () => {
    const n = heldNetwork(ORGS);
    void n.registrar.setDevice('T', 'ios');
    await n.flush();
    void n.registrar.syncServer('https://one.test');
    await n.flush();
    // one.test's second request waits; two.test was never blocked.
    expect(n.sent).toEqual([
      'POST https://one.test/api/devices',
      'POST https://two.test/api/devices',
    ]);
    await n.releaseNext();
    expect(n.sent.at(-1)).toBe('POST https://one.test/api/devices');
  });
});

/** A store shared between registrar instances, standing in for AsyncStorage. */
function sharedStore() {
  let saved: string[] = [];
  return {
    store: {
      load: async () => [...saved],
      save: async (origins: string[]) => {
        saved = [...origins];
      },
    },
    saved: () => saved,
  };
}

function apiKeyHarness(store: ReturnType<typeof sharedStore>['store']) {
  // one.test is saved with an API key AND a login: signing out drops only the login.
  const orgs = [{ id: 'a', remoteUrl: 'https://one.test', apiKey: 'key-one' }];
  const logins: Record<string, string> = { 'https://one.test': 'jwt-one' };
  const sent: string[] = [];
  const registrar = createPushRegistrar({
    deps: {
      loginTokenFor: async (url) => logins[url] ?? null,
      fetch: async (url, init) => {
        const auth = init.headers.Authorization
          ? 'login'
          : init.headers['X-API-Key']
            ? 'api-key'
            : 'none';
        sent.push(`${init.method} ${url} (${auth})`);
        return { ok: true, status: 200 };
      },
    },
    getOrgs: () => orgs,
    signedOutStore: store,
    log: () => {},
  });
  return { registrar, sent, logins };
}

describe('explicit sign-out', () => {
  it('a saved API key cannot re-enable push after sign-out: not on sync, switch or restart', async () => {
    const { store, saved } = sharedStore();
    const h = apiKeyHarness(store);
    await h.registrar.setDevice('T', 'ios');
    await h.registrar.signOut('https://one.test', async () => {
      delete h.logins['https://one.test'];
    });
    expect(saved()).toEqual(['https://one.test']);
    h.sent.length = 0;

    await h.registrar.syncAll();
    await h.registrar.syncServer('https://one.test');
    expect(h.sent).toEqual([]);

    // App restart: a fresh registrar reading the same persisted state.
    const restarted = apiKeyHarness(store);
    await restarted.registrar.setDevice('T', 'ios');
    expect(restarted.sent).toEqual([]);
  });

  it('signing in again re-enables push for that server', async () => {
    const { store, saved } = sharedStore();
    const h = apiKeyHarness(store);
    await h.registrar.setDevice('T', 'ios');
    await h.registrar.signOut('https://one.test', async () => {
      delete h.logins['https://one.test'];
    });
    h.sent.length = 0;
    h.logins['https://one.test'] = 'jwt-again';
    await h.registrar.signedIn('https://one.test');
    expect(h.sent).toEqual(['POST https://one.test/api/devices (login)']);
    expect(saved()).toEqual([]);
  });

  it('a sign-in requested during a sign-out takes effect after it, not before', async () => {
    const n = heldNetwork(ORGS.slice(0, 1), { 'https://one.test': 'jwt-one' });
    await (async () => {
      const launch = n.registrar.setDevice('T', 'ios');
      await n.releaseNext();
      await launch;
    })();
    const out = n.registrar.signOut('https://one.test', async () => {
      // Like the real logout: only clears the login it signed out with.
      if (n.state.logins['https://one.test'] === 'jwt-one')
        delete n.state.logins['https://one.test'];
    });
    n.state.logins['https://one.test'] = 'jwt-new';
    const back = n.registrar.signedIn('https://one.test');
    await n.releaseNext(); // DELETE
    await n.releaseNext(); // POST from the sign-in
    await Promise.all([out, back]);
    expect(n.sent.slice(-2)).toEqual([
      'DELETE https://one.test/api/devices/T (signed in)',
      'POST https://one.test/api/devices (signed in)',
    ]);
  });

  it('deleting the server entirely clears its sign-out, so adding it back starts fresh', async () => {
    const { store, saved } = sharedStore();
    const h = apiKeyHarness(store);
    await h.registrar.setDevice('T', 'ios');
    await h.registrar.signOut('https://one.test', async () => {});
    await h.registrar.forget({ id: 'a', remoteUrl: 'https://one.test' }, async () => {});
    expect(saved()).toEqual([]);
  });
});

describe('stalled servers', () => {
  // Accepts the request and never answers.
  const stalled = (calls: string[]): ServerPushDeps => ({
    timeoutMs: 20,
    loginTokenFor: async () => 'jwt',
    fetch: (url, init) => {
      calls.push(`${init.method} ${url}`);
      return new Promise(() => {});
    },
  });

  it('deleting a server still applies when it never answers the DELETE', async () => {
    const calls: string[] = [];
    let orgs = [...ORGS];
    const registrar = createPushRegistrar({
      deps: stalled(calls),
      getOrgs: () => orgs,
      log: () => {},
    });
    await registrar.setDevice('T', 'ios');
    const applied = vi.fn(async () => {
      orgs = orgs.filter((o) => o.id !== 'b');
    });
    await expect(registrar.forget(ORGS[1], applied)).resolves.toBe(false);
    expect(applied).toHaveBeenCalledTimes(1);
    expect(calls).toContain('DELETE https://two.test/api/devices/T');
  });

  it('sign-out still clears the login when the server never answers', async () => {
    const calls: string[] = [];
    const registrar = createPushRegistrar({
      deps: stalled(calls),
      getOrgs: () => ORGS,
      log: () => {},
    });
    await registrar.setDevice('T', 'ios');
    const clearLogin = vi.fn(async () => {});
    await registrar.signOut('https://one.test', clearLogin);
    expect(clearLogin).toHaveBeenCalledTimes(1);
  });

  it('a stalled registration ahead in the queue delays removal only until it times out', async () => {
    const calls: string[] = [];
    const registrar = createPushRegistrar({
      deps: stalled(calls),
      getOrgs: () => ORGS,
      log: () => {},
    });
    const launch = registrar.setDevice('T', 'ios'); // POSTs hang
    const applied = vi.fn(async () => {});
    const removal = registrar.forget(ORGS[1], applied);
    await Promise.all([launch, removal]);
    expect(applied).toHaveBeenCalledTimes(1);
    // Order kept: the POST went out before the DELETE.
    const two = calls.filter((c) => c.includes('two.test'));
    expect(two).toEqual([
      'POST https://two.test/api/devices',
      'DELETE https://two.test/api/devices/T',
    ]);
  });
});
