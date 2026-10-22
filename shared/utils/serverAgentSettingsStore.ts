/**
 * Account-scoped cache for the signed-in user's Server Agent settings, shared
 * by web and mobile.
 *
 * The store is told about every account change through `setAccount`,
 * including sign-out (`null`); the binding calls it whenever the observed
 * account key changes. Each change starts a new epoch and drops the cache,
 * the in-flight load and any load error. Loads, load errors and saves apply
 * their result only in the epoch they started in, so nothing started for an
 * earlier session (another account, or the same user before a sign-out)
 * can land in the current one. Account keys must change on every sign-in,
 * so a re-login as the same user is a new account even when nothing observed
 * the signed-out state in between.
 */
import type { ServerAgentSkillRef } from './hub';

export interface ServerAgentSettings {
  name: string;
  instructions: string;
  /** Skills the user added on top of the built-in set. */
  skills?: ServerAgentSkillRef[];
  /** Skill ids the Server Agent always loads. */
  builtInSkills?: string[];
  defaultName: string;
  effectiveName: string;
}

export interface ServerAgentSettingsBody {
  name?: string;
  instructions?: string;
  skills?: ServerAgentSkillRef[];
}

export class ServerAgentAccountChangedError extends Error {
  constructor() {
    super('You switched accounts. Reload the settings before saving.');
    this.name = 'ServerAgentAccountChangedError';
  }
}

export interface ServerAgentSettingsStore {
  /** Settings cached for `accountKey`, or null when none are loaded for it. */
  get(accountKey: string | null): ServerAgentSettings | null;
  /** Why the last load for `accountKey` failed; null once a load succeeds. */
  loadError(accountKey: string | null): string | null;
  /** The account the app now serves, or null when none. Starts a new epoch on change. */
  setAccount(accountKey: string | null): void;
  /** Fetch for `accountKey` (made current first). Deduplicates within an epoch. */
  load(accountKey: string): Promise<ServerAgentSettings | null>;
  /** Save for `accountKey`; refused when another account is current. */
  save(accountKey: string, body: ServerAgentSettingsBody): Promise<ServerAgentSettings>;
  subscribe(listener: () => void): () => void;
  /** Changes whenever the cache does; use as the external-store snapshot. */
  version(): number;
  reset(): void;
}

export function createServerAgentSettingsStore(deps: {
  fetch: () => Promise<ServerAgentSettings>;
  put: (body: ServerAgentSettingsBody) => Promise<ServerAgentSettings>;
}): ServerAgentSettingsStore {
  let currentKey: string | null = null;
  let epoch = 0;
  let cached: { key: string; settings: ServerAgentSettings } | null = null;
  let inflight: {
    key: string;
    epoch: number;
    promise: Promise<ServerAgentSettings | null>;
  } | null = null;
  let failure: { key: string; message: string } | null = null;
  let rev = 0;
  const listeners = new Set<() => void>();

  const emit = () => {
    rev += 1;
    for (const l of listeners) l();
  };

  const setAccount = (key: string | null) => {
    if (currentKey === key) return;
    currentKey = key;
    epoch += 1;
    inflight = null;
    cached = null;
    failure = null;
    emit();
  };

  const store: ServerAgentSettingsStore = {
    get(accountKey) {
      return accountKey !== null && cached?.key === accountKey ? cached.settings : null;
    },
    loadError(accountKey) {
      return accountKey !== null && failure?.key === accountKey ? failure.message : null;
    },
    setAccount,
    load(accountKey) {
      setAccount(accountKey);
      if (inflight?.key === accountKey && inflight.epoch === epoch) return inflight.promise;
      const started = epoch;
      if (failure?.key === accountKey) {
        failure = null;
        emit();
      }
      const entry = {
        key: accountKey,
        epoch: started,
        promise: Promise.resolve()
          .then(() => deps.fetch())
          .then((settings) => {
            if (epoch !== started) return null;
            cached = { key: accountKey, settings };
            failure = null;
            emit();
            return settings;
          })
          .catch((err: unknown) => {
            if (epoch === started) {
              failure = {
                key: accountKey,
                message: err instanceof Error && err.message ? err.message : 'Request failed',
              };
              emit();
            }
            return epoch === started ? store.get(accountKey) : null;
          })
          .finally(() => {
            if (inflight === entry) inflight = null;
          }),
      };
      inflight = entry;
      return entry.promise;
    },
    async save(accountKey, body) {
      if (currentKey !== accountKey) throw new ServerAgentAccountChangedError();
      const started = epoch;
      const saved = await deps.put(body);
      if (epoch === started) {
        cached = { key: accountKey, settings: saved };
        emit();
      }
      return saved;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    version() {
      return rev;
    },
    reset() {
      setAccount(null);
    },
  };
  return store;
}

export interface ServerAgentSettingsHooks {
  useSyncExternalStore: <T>(subscribe: (l: () => void) => () => void, get: () => T) => T;
  useEffect: (effect: () => void | (() => void), deps: readonly unknown[]) => void;
}

/** Display name for the Server Agent: the user's pick, else the default. */
export function serverAgentDisplayName(
  settings: ServerAgentSettings | null,
  defaultName: string,
): string {
  return settings?.name?.trim() || defaultName;
}

/**
 * The React binding both apps use. Each platform injects its API calls, its
 * React hooks, and the hook that names the signed-in account: null while no
 * account is served, and a new value on every sign-in. Every hook reports the
 * account it observes to the store, so sign-out invalidates it even when no
 * component is loading.
 */
export function createServerAgentSettingsBinding(deps: {
  fetch: () => Promise<ServerAgentSettings>;
  put: (body: ServerAgentSettingsBody) => Promise<ServerAgentSettings>;
  useAccountKey: () => string | null;
  hooks: ServerAgentSettingsHooks;
}) {
  const store = createServerAgentSettingsStore({ fetch: deps.fetch, put: deps.put });
  const { useSyncExternalStore, useEffect } = deps.hooks;
  const useVersion = () => useSyncExternalStore(store.subscribe, store.version);

  return {
    useServerAgentAccountKey: deps.useAccountKey,
    useServerAgentSettings(enabled = true): ServerAgentSettings | null {
      const accountKey = deps.useAccountKey();
      useVersion();
      useEffect(() => {
        store.setAccount(accountKey);
        if (enabled && accountKey && !store.get(accountKey)) void store.load(accountKey);
      }, [enabled, accountKey]);
      return store.get(accountKey);
    },
    /** The last load error for the signed-in account, and a retry that clears it. */
    useServerAgentLoadError(): { error: string | null; retry: () => void } {
      const accountKey = deps.useAccountKey();
      useVersion();
      useEffect(() => {
        store.setAccount(accountKey);
      }, [accountKey]);
      return {
        error: store.loadError(accountKey),
        retry: () => {
          if (accountKey) void store.load(accountKey);
        },
      };
    },
    saveServerAgentSettings: (accountKey: string, body: ServerAgentSettingsBody) =>
      store.save(accountKey, body),
    resetServerAgentSettingsForTests: () => store.reset(),
  };
}
