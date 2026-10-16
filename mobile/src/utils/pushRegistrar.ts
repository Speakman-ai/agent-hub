/**
 * The one owner of this phone's push registrations across saved servers.
 *
 * Every lifecycle event that can change which servers should push here goes
 * through this object: getting the push token at launch, signing in,
 * switching servers, adding/editing/deleting a saved server, and signing
 * out. Callers never talk to `/api/devices` themselves.
 *
 * Work for one server runs strictly in call order, one request at a time.
 * Removal (delete, re-point, sign-out) runs its DELETE and then the change it
 * guards (dropping the saved entry, clearing the login) inside the same turn,
 * so a registration that was already in flight finishes before the DELETE,
 * and one asked for afterwards sees the server gone or signed out instead of
 * recreating the record. Every request is time-bounded (see `call` in
 * serverPush), so a stalled server can delay that by seconds, never block it.
 *
 * Whether a server may push here is explicit state, not inferred from which
 * credentials happen to exist: signing out records the server as opted out
 * (persisted), and nothing registers with it again, at any sync or after a
 * restart, until the user signs in to it again. A saved API key does not
 * count as signing back in.
 */
import { authOriginOf } from './auth';
import {
  mayUnregisterServer,
  pushServersFromOrgs,
  registerPushTokenWithServers,
  unregisterPushTokenFromServer,
  type PushServer,
  type ServerPushDeps,
  type ServerPushResult,
} from './serverPush';

/** Persistence for the servers the user signed out of (origins). */
export interface SignedOutStore {
  load: () => Promise<string[]>;
  save: (origins: string[]) => Promise<void>;
}

export interface PushRegistrarOptions {
  deps: ServerPushDeps;
  /** Current saved servers (orgs). Read when each request runs, not when queued. */
  getOrgs: () => any[] | null | undefined;
  signedOutStore?: SignedOutStore;
  log?: (msg: string, detail?: unknown) => void;
}

function memoryStore(): SignedOutStore {
  let saved: string[] = [];
  return {
    load: async () => saved,
    save: async (origins) => {
      saved = origins;
    },
  };
}

export function createPushRegistrar({
  deps,
  getOrgs,
  signedOutStore = memoryStore(),
  log = console.warn,
}: PushRegistrarOptions) {
  let token: string | null = null;
  let platform = 'ios';
  const queues = new Map<string, Promise<unknown>>();

  // Loaded once; every registration waits for it, so a launch sync can't
  // run before the persisted sign-outs are known.
  const signedOut = new Set<string>();
  // Read on first use, not at creation: the app creates the registrar at
  // import time, before storage is needed (or available, in tests).
  let loading: Promise<void> | null = null;
  const loaded = () =>
    (loading ??= signedOutStore
      .load()
      .then((origins) => origins.forEach((o) => signedOut.add(o)))
      .catch((err) => log('[push] could not read signed-out servers', err)));
  const persistSignedOut = () =>
    signedOutStore
      .save([...signedOut])
      .catch((err) => log('[push] could not save signed-out servers', err));

  /** Run `op` after every earlier operation for the same server. */
  function serialized<T>(origin: string, op: () => Promise<T>): Promise<T> {
    const prev = queues.get(origin) ?? Promise.resolve();
    const next = prev.then(op, op);
    const tail = next.catch(() => {});
    queues.set(origin, tail);
    void tail.then(() => {
      if (queues.get(origin) === tail) queues.delete(origin);
    });
    return next;
  }

  const describe = (r: ServerPushResult) => `${r.serverUrl} ${r.status ?? r.error ?? ''}`;

  function savedServer(origin: string): PushServer | undefined {
    return pushServersFromOrgs(getOrgs()).find((s) => authOriginOf(s.serverUrl) === origin);
  }

  function registerOne(origin: string): Promise<ServerPushResult | null> {
    return serialized(origin, async () => {
      await loaded();
      // Looked up now: a removal or sign-out queued before this has applied.
      const server = savedServer(origin);
      if (!token || !server || signedOut.has(origin)) return null;
      const [result] = await registerPushTokenWithServers(token, platform, [server], deps);
      if (!result.ok) log('[push] register failed', describe(result));
      return result;
    });
  }

  async function registerOrigins(origins: string[]): Promise<ServerPushResult[]> {
    const results = await Promise.all(origins.map(registerOne));
    return results.filter((r): r is ServerPushResult => r !== null);
  }

  async function unregister(server: PushServer, what: string) {
    if (!token) return false;
    const result = await unregisterPushTokenFromServer(token, server, deps);
    if (!result.ok) log(`[push] ${what} failed`, describe(result));
    return result.ok;
  }

  return {
    /** The device's push token became known (launch). Registers everywhere. */
    setDevice(nextToken: string, nextPlatform: string): Promise<ServerPushResult[]> {
      token = nextToken;
      platform = nextPlatform;
      return this.syncAll();
    },

    getToken: () => token,

    /** Register with every saved server. Idempotent; failures stay per server. */
    syncAll(): Promise<ServerPushResult[]> {
      if (!token) return Promise.resolve([]);
      const origins = pushServersFromOrgs(getOrgs()).map((s) => authOriginOf(s.serverUrl)!);
      return registerOrigins(origins);
    },

    /**
     * Register with one server, e.g. the one just switched to. Retries a
     * server that was unreachable at launch. A server signed out of stays
     * unregistered.
     */
    syncServer(serverUrl: string | null | undefined): Promise<ServerPushResult[]> {
      const origin = authOriginOf(serverUrl);
      if (!token || !origin) return Promise.resolve([]);
      return registerOrigins([origin]);
    },

    /**
     * The user signed in to a server: it may push here again. Clears its
     * sign-out and registers with it.
     */
    signedIn(serverUrl: string | null | undefined): Promise<ServerPushResult[]> {
      const origin = authOriginOf(serverUrl);
      if (!origin) return Promise.resolve([]);
      // Queued so it can't overtake a sign-out still in progress.
      return serialized(origin, async () => {
        await loaded();
        if (signedOut.delete(origin)) await persistSignedOut();
      }).then(() => this.syncServer(serverUrl));
    },

    /**
     * Delete or re-point a saved entry. `applyRemoval` makes the change; it
     * always runs. When no other saved entry uses the entry's server, the
     * server is first told to stop pushing here, using the entry's login.
     */
    forget(org: any, applyRemoval: () => Promise<unknown>): Promise<boolean> {
      const origin = authOriginOf(org?.remoteUrl);
      if (!origin) return applyRemoval().then(() => false);
      return serialized(origin, async () => {
        let removed = false;
        let lastEntry = false;
        try {
          const [server] = pushServersFromOrgs([org]);
          lastEntry = mayUnregisterServer(getOrgs(), org.id, org.remoteUrl);
          if (server && lastEntry) removed = await unregister(server, 'unregister');
        } catch (err) {
          log('[push] unregister failed', err);
        }
        await applyRemoval();
        // The server is no longer saved at all; adding it back starts fresh.
        if (lastEntry) {
          await loaded();
          if (signedOut.delete(origin)) await persistSignedOut();
        }
        return removed;
      });
    },

    /**
     * Sign out of a server: record it as signed out (so no later sync, API
     * key or restart registers it again), ask it to stop pushing here with
     * the login that is about to go, then run `clearLogin`. Sign-out always
     * completes, even when the server can't be reached or never answers.
     */
    signOut(serverUrl: string | null | undefined, clearLogin: () => Promise<unknown>) {
      const origin = authOriginOf(serverUrl);
      if (!origin) return clearLogin().then(() => undefined);
      return serialized(origin, async () => {
        try {
          await loaded();
          signedOut.add(origin);
          await persistSignedOut();
          const [server] = pushServersFromOrgs([{ id: '_', remoteUrl: serverUrl }]);
          if (server) await unregister(server, 'unregister on sign-out');
        } catch (err) {
          log('[push] unregister on sign-out failed', err);
        }
        await clearLogin();
      });
    },
  };
}

export type PushRegistrar = ReturnType<typeof createPushRegistrar>;
