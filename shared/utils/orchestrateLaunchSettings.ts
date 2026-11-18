/**
 * Orchestrate launch state shared by web and mobile: per-chat Default build
 * and Auto start, whether a chat is in Orchestrate right now, per-card
 * countdown deadlines, and saved per-card cancels.
 *
 * The platform seam is injected: `storage` is localStorage on web (sync) and
 * AsyncStorage on mobile (async), and `useSyncExternalStore` comes from the
 * app's React. With async storage, saved settings arrive after first read and
 * a card counts as blocked until saved cancels have loaded, so no countdown
 * can start or fire before a cancel is known. With sync storage, the claim
 * re-reads saved cancels just before firing, and `handleStorageEvent` lets
 * another tab's changes reach this one.
 */
import { parseSessionForwardMode, type SessionForwardMode } from './extractForwardBlocks';

/** How long an Orchestrate forward waits before it starts on its own. */
export const ORCHESTRATE_AUTO_START_SECONDS = 30;

export interface OrchestrateLaunchSettings {
  mode: SessionForwardMode;
  autoStart: boolean;
}

export interface OrchestrateLaunchStorage {
  getItem(key: string): string | null | Promise<string | null>;
  setItem(key: string, value: string): void | Promise<void>;
}

type UseSyncExternalStore = <T>(
  subscribe: (listener: () => void) => () => void,
  getSnapshot: () => T,
  getServerSnapshot?: () => T,
) => T;

export const ORCHESTRATE_CANCELLED_KEY = 'agenthub:orchestrate-autostart-cancelled';
export const ORCHESTRATE_LAUNCH_KEY_PREFIX = 'agenthub:orchestrate-launch:';
const MAX_SAVED_CANCELS = 500;
const DEFAULT_SETTINGS: OrchestrateLaunchSettings = { mode: 'manual', autoStart: false };

function isPromise<T>(value: unknown): value is Promise<T> {
  return !!value && typeof (value as { then?: unknown }).then === 'function';
}

function parseSettings(raw: string | null): OrchestrateLaunchSettings {
  if (!raw) return DEFAULT_SETTINGS;
  try {
    const parsed = JSON.parse(raw) as Partial<OrchestrateLaunchSettings>;
    const mode = parseSessionForwardMode(parsed.mode);
    return { mode: mode === 'consult' ? 'manual' : mode, autoStart: parsed.autoStart === true };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

function parseCancels(raw: string | null): string[] {
  try {
    const ids = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string') : [];
  } catch {
    return [];
  }
}

export function createOrchestrateLaunchStore(deps: {
  storage: OrchestrateLaunchStorage;
  useSyncExternalStore: UseSyncExternalStore;
}) {
  const { storage, useSyncExternalStore } = deps;

  const read = (key: string): string | null | Promise<string | null> => {
    try {
      return storage.getItem(key);
    } catch {
      return null;
    }
  };
  const write = (key: string, value: string) => {
    try {
      const result = storage.setItem(key, value);
      if (isPromise(result)) {
        result.catch(() => {
          /* the value still holds in memory until the app closes */
        });
      }
    } catch {
      /* a private window can refuse storage; the value holds in memory */
    }
  };

  // ---- per-chat settings ----
  const cache = new Map<string, OrchestrateLaunchSettings>();
  const listeners = new Map<string, Set<() => void>>();
  const inflight = new Set<string>();

  const notify = (sessionId: string) => {
    for (const listener of [...(listeners.get(sessionId) ?? [])]) listener();
  };

  function getSettings(sessionId: string | null | undefined): OrchestrateLaunchSettings {
    if (!sessionId) return DEFAULT_SETTINGS;
    const held = cache.get(sessionId);
    if (held) return held;
    const raw = read(ORCHESTRATE_LAUNCH_KEY_PREFIX + sessionId);
    if (!isPromise<string | null>(raw)) {
      const loaded = parseSettings(raw);
      cache.set(sessionId, loaded);
      return loaded;
    }
    if (!inflight.has(sessionId)) {
      inflight.add(sessionId);
      raw.then(
        (value) => {
          inflight.delete(sessionId);
          if (cache.has(sessionId)) return;
          const next = parseSettings(value);
          cache.set(sessionId, next);
          if (next.autoStart || next.mode !== 'manual') notify(sessionId);
        },
        () => {
          inflight.delete(sessionId);
        },
      );
    }
    return DEFAULT_SETTINGS;
  }

  function setSettings(sessionId: string, patch: Partial<OrchestrateLaunchSettings>): void {
    const next: OrchestrateLaunchSettings = { ...getSettings(sessionId), ...patch };
    if (next.mode === 'consult') next.mode = 'manual';
    cache.set(sessionId, next);
    write(ORCHESTRATE_LAUNCH_KEY_PREFIX + sessionId, JSON.stringify(next));
    notify(sessionId);
  }

  function subscribeSettings(
    sessionId: string | null | undefined,
    listener: () => void,
  ): () => void {
    if (!sessionId) return () => {};
    const group = listeners.get(sessionId) ?? new Set();
    group.add(listener);
    listeners.set(sessionId, group);
    return () => {
      group.delete(listener);
      if (group.size === 0) listeners.delete(sessionId);
    };
  }

  // ---- whether a chat is in Orchestrate right now ----
  const orchestrating = new Set<string>();

  function setSessionActive(sessionId: string, active: boolean): void {
    if (orchestrating.has(sessionId) === active) return;
    if (active) orchestrating.add(sessionId);
    else orchestrating.delete(sessionId);
    notify(sessionId);
  }

  const isSessionActive = (sessionId: string | null | undefined): boolean =>
    Boolean(sessionId && orchestrating.has(sessionId));

  // ---- per-card countdowns and saved cancels ----
  const deadlines = new Map<string, number>();
  const fired = new Set<string>();
  const cancelled = new Set<string>();
  let cancelLoad: 'idle' | 'loading' | 'ready' = 'idle';
  let cancelDirty = false;
  const autoStartListeners = new Set<() => void>();

  const notifyAutoStart = () => {
    for (const listener of [...autoStartListeners]) listener();
  };

  /** Add saved cancels; saved ones go first so ones made this run stay newest. */
  const mergeSaved = (ids: string[]): boolean => {
    const before = cancelled.size;
    const merged = [...ids, ...cancelled];
    cancelled.clear();
    for (const id of merged) cancelled.add(id);
    return cancelled.size !== before;
  };

  const saveCancels = () =>
    write(ORCHESTRATE_CANCELLED_KEY, JSON.stringify([...cancelled].slice(-MAX_SAVED_CANCELS)));

  // Set on the first read: localStorage answers synchronously, AsyncStorage
  // with a promise.
  let syncStorage = false;

  /**
   * Pull in saved cancels. Sync storage re-reads on every call (another tab may
   * have written); async storage loads once. Only a re-read notifies: the first
   * load can run inside a render snapshot, where notifying is not allowed.
   */
  function loadCancels(): void {
    if (cancelLoad === 'loading') return;
    if (cancelLoad === 'ready' && !syncStorage) return;
    const firstLoad = cancelLoad === 'idle';
    const raw = read(ORCHESTRATE_CANCELLED_KEY);
    if (!isPromise<string | null>(raw)) {
      syncStorage = true;
      cancelLoad = 'ready';
      if (mergeSaved(parseCancels(raw)) && !firstLoad) notifyAutoStart();
      return;
    }
    cancelLoad = 'loading';
    const finish = (value: string | null) => {
      mergeSaved(parseCancels(value));
      cancelLoad = 'ready';
      if (cancelDirty) {
        cancelDirty = false;
        saveCancels();
      }
      notifyAutoStart();
    };
    raw.then(finish, () => finish(null));
  }

  /** Cancelled, or not known yet because saved cancels are still loading. */
  function isBlocked(identity: string): boolean {
    if (cancelLoad === 'idle') loadCancels();
    return cancelLoad !== 'ready' || cancelled.has(identity);
  }

  function cancel(identity: string): void {
    // Merge with what other tabs saved so this write cannot drop their cancels.
    loadCancels();
    cancelled.delete(identity);
    cancelled.add(identity);
    if (cancelLoad === 'ready') saveCancels();
    else cancelDirty = true;
    deadlines.delete(identity);
    fired.delete(identity);
    notifyAutoStart();
  }

  /** True the first time this card should dispatch. Later calls are ignored. */
  function markFired(identity: string): boolean {
    // A cancel from any instance of this card, in this tab or another, wins.
    // Sync storage is re-read here so a missed storage event cannot let it fire.
    if (syncStorage) loadCancels();
    if (isBlocked(identity) || fired.has(identity)) return false;
    fired.add(identity);
    deadlines.delete(identity);
    return true;
  }

  function subscribeAutoStart(listener: () => void): () => void {
    autoStartListeners.add(listener);
    return () => {
      autoStartListeners.delete(listener);
    };
  }

  /**
   * Another tab wrote launch state. A cancel there stops this tab's countdown
   * for the card, and a settings change reaches this tab's cards. `null`
   * means storage was cleared.
   */
  function handleStorageEvent(key: string | null): void {
    if (key === null || key === ORCHESTRATE_CANCELLED_KEY) loadCancels();
    if (key === null) {
      for (const sessionId of [...cache.keys()]) {
        cache.delete(sessionId);
        notify(sessionId);
      }
    } else if (key.startsWith(ORCHESTRATE_LAUNCH_KEY_PREFIX)) {
      const sessionId = key.slice(ORCHESTRATE_LAUNCH_KEY_PREFIX.length);
      cache.delete(sessionId);
      notify(sessionId);
    }
  }

  return {
    getOrchestrateLaunchSettings: getSettings,
    setOrchestrateLaunchSettings: setSettings,
    subscribeOrchestrateLaunchSettings: subscribeSettings,
    useOrchestrateLaunchSettings(sessionId: string | null | undefined) {
      return useSyncExternalStore(
        (listener) => subscribeSettings(sessionId, listener),
        () => getSettings(sessionId),
        () => DEFAULT_SETTINGS,
      );
    },
    /**
     * Publish whether a chat is in Orchestrate mode right now. Forward cards
     * only count down while it is, so leaving Orchestrate stops pending starts.
     */
    setOrchestrateSessionActive: setSessionActive,
    isOrchestrateSessionActive: isSessionActive,
    useOrchestrateSessionActive(sessionId: string | null | undefined): boolean {
      return useSyncExternalStore(
        (listener) => subscribeSettings(sessionId, listener),
        () => isSessionActive(sessionId),
        () => false,
      );
    },
    /** Deadline for one card. A remount keeps the original 30 seconds. */
    orchestrateAutoStartDeadline(identity: string, now = Date.now()): number {
      const existing = deadlines.get(identity);
      if (existing != null) return existing;
      const deadline = now + ORCHESTRATE_AUTO_START_SECONDS * 1000;
      deadlines.set(identity, deadline);
      return deadline;
    },
    orchestrateAutoStartRemaining(identity: string, now = Date.now()): number {
      const deadline = deadlines.get(identity);
      if (deadline == null) return ORCHESTRATE_AUTO_START_SECONDS;
      return Math.max(0, Math.ceil((deadline - now) / 1000));
    },
    subscribeOrchestrateAutoStart: subscribeAutoStart,
    cancelOrchestrateAutoStart: cancel,
    isOrchestrateAutoStartCancelled: isBlocked,
    useOrchestrateAutoStartCancelled(identity: string): boolean {
      return useSyncExternalStore(
        subscribeAutoStart,
        () => isBlocked(identity),
        () => false,
      );
    },
    markOrchestrateAutoStartFired: markFired,
    /** Drop a countdown without remembering a cancel, so Auto start can begin again. */
    releaseOrchestrateAutoStart(identity: string): void {
      deadlines.delete(identity);
      fired.delete(identity);
    },
    handleOrchestrateStorageEvent: handleStorageEvent,
    resetOrchestrateLaunchStateForTests(): void {
      cache.clear();
      listeners.clear();
      inflight.clear();
      orchestrating.clear();
      deadlines.clear();
      fired.clear();
      cancelled.clear();
      cancelLoad = 'idle';
      cancelDirty = false;
      syncStorage = false;
      notifyAutoStart();
    },
  };
}

export type OrchestrateLaunchStore = ReturnType<typeof createOrchestrateLaunchStore>;
