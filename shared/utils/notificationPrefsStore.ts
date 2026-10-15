/**
 * Client-side owner of the caller's notification preferences, shared by web
 * and mobile. Each platform creates one instance and injects its API calls
 * and its notion of "who is signed in".
 *
 * Load and save state lives here rather than in a settings view so pending
 * saves keep draining after the view unmounts.
 *
 * Saves are serialized: at most one PUT is in flight, and edits made while it
 * runs are coalesced into `queued` and sent once it settles. Responses arrive
 * in order, so the newest one is the server's current state. The displayed
 * matrix is that confirmed state with in-flight and queued edits on top.
 */
import {
  NOTIFICATION_SECTIONS,
  PUSH_EVENT_CATEGORIES,
  isNotificationCategoryId,
  type NotificationChannel,
  type PushEventType,
} from './notificationCategories';

export type ChannelValues = Record<NotificationChannel, boolean>;
export type PrefsMap = Record<string, ChannelValues>;
export type NotificationPrefsPatch = Record<string, Partial<Record<NotificationChannel, boolean>>>;

/** The part of the `/api/me/notification-preferences` response the store reads. */
export interface NotificationPrefsResponse {
  categories: ({ category: string } & Record<NotificationChannel, boolean>)[];
}

export interface NotificationPrefsState {
  loaded: boolean;
  loading: boolean;
  error: string | null;
  prefs: PrefsMap;
}

export interface NotificationPrefsStoreDeps {
  getPrefs: () => Promise<NotificationPrefsResponse>;
  putPrefs: (patch: NotificationPrefsPatch) => Promise<NotificationPrefsResponse>;
  /** Stable key for the signed-in account; a change resets all state. */
  currentOwner: () => string | null;
}

export interface NotificationPrefsStore {
  subscribe: (listener: () => void) => () => void;
  getSnapshot: () => NotificationPrefsState;
  loadNotificationPrefs: () => Promise<void>;
  saveNotificationPrefs: (patch: NotificationPrefsPatch) => void;
  isNotificationChannelEnabled: (category: string, channel: NotificationChannel) => boolean;
  resetNotificationPrefsStoreForTests: () => void;
}

interface Internal {
  owner: string | null;
  loaded: boolean;
  loading: boolean;
  error: string | null;
  confirmed: PrefsMap;
  inflight: NotificationPrefsPatch | null;
  queued: NotificationPrefsPatch;
  /** Bumped whenever a save is accepted; a GET started before it is stale. */
  saveGen: number;
}

export function catalogDefaults(): PrefsMap {
  const out: PrefsMap = {};
  for (const s of NOTIFICATION_SECTIONS) {
    for (const c of s.categories) out[c.id] = { ...c.defaults };
  }
  return out;
}

export function applyPatch(prefs: PrefsMap, patch: NotificationPrefsPatch): PrefsMap {
  const next = { ...prefs };
  for (const [category, channels] of Object.entries(patch)) {
    next[category] = { ...next[category], ...channels } as ChannelValues;
  }
  return next;
}

function mergePatch(a: NotificationPrefsPatch, b: NotificationPrefsPatch): NotificationPrefsPatch {
  const out: NotificationPrefsPatch = { ...a };
  for (const [category, channels] of Object.entries(b)) {
    out[category] = { ...out[category], ...channels };
  }
  return out;
}

function fromResponse(res: NotificationPrefsResponse): NotificationPrefsPatch {
  const out: NotificationPrefsPatch = {};
  for (const c of res?.categories ?? []) {
    out[c.category] = { in_app: c.in_app, desktop: c.desktop, push: c.push };
  }
  return out;
}

function fresh(owner: string | null): Internal {
  return {
    owner,
    loaded: false,
    loading: false,
    error: null,
    confirmed: catalogDefaults(),
    inflight: null,
    queued: {},
    saveGen: 0,
  };
}

export function createNotificationPrefsStore(
  deps: NotificationPrefsStoreDeps,
): NotificationPrefsStore {
  let state: Internal = fresh(null);
  let snapshot: NotificationPrefsState | null = null;
  const listeners = new Set<() => void>();

  function emit() {
    snapshot = null;
    for (const l of listeners) l();
  }

  /** A different signed-in user must never see or send the previous user's edits. */
  function ensureOwner() {
    const owner = deps.currentOwner();
    if (owner !== state.owner) {
      state = fresh(owner);
      snapshot = null;
    }
  }

  function getSnapshot(): NotificationPrefsState {
    if (!snapshot) {
      snapshot = {
        loaded: state.loaded,
        loading: state.loading,
        error: state.error,
        prefs: applyPatch(applyPatch(state.confirmed, state.inflight ?? {}), state.queued),
      };
    }
    return snapshot;
  }

  /**
   * Fetch the stored matrix. Already-loaded state is refreshed only while no
   * save is pending, and the result is dropped if a save was accepted after
   * the GET started, since that save's response is newer.
   */
  function loadNotificationPrefs(): Promise<void> {
    ensureOwner();
    if (state.loading) return Promise.resolve();
    if (state.loaded && (state.inflight || Object.keys(state.queued).length)) {
      return Promise.resolve();
    }
    const target = state;
    const gen = state.saveGen;
    target.loading = true;
    emit();
    return deps
      .getPrefs()
      .then((res) => {
        if (state !== target) return;
        if (target.saveGen === gen && !target.inflight) {
          target.confirmed = applyPatch(target.confirmed, fromResponse(res));
        }
        target.loaded = true;
        target.error = null;
      })
      .catch((err: any) => {
        if (state !== target) return;
        if (!target.loaded)
          target.error = err?.message || 'Failed to load notification preferences';
      })
      .finally(() => {
        if (state !== target) return;
        target.loading = false;
        emit();
      });
  }

  function drain(target: Internal) {
    if (state !== target || target.inflight || !Object.keys(target.queued).length) return;
    if (deps.currentOwner() !== target.owner) {
      state = fresh(deps.currentOwner());
      emit();
      return;
    }
    const patch = target.queued;
    target.inflight = patch;
    target.queued = {};
    emit();
    deps
      .putPrefs(patch)
      .then((res) => {
        if (state === target) target.confirmed = applyPatch(target.confirmed, fromResponse(res));
      })
      .catch((err: any) => {
        if (state === target)
          target.error = err?.message || 'Failed to save notification preferences';
      })
      .finally(() => {
        if (state !== target) return;
        target.inflight = null;
        emit();
        drain(target);
      });
  }

  /** Apply an edit locally and queue it for saving. Ignored until loaded. */
  function saveNotificationPrefs(patch: NotificationPrefsPatch): void {
    ensureOwner();
    if (!state.loaded) return;
    state.error = null;
    state.queued = mergePatch(state.queued, patch);
    state.saveGen += 1;
    emit();
    drain(state);
  }

  /**
   * Whether the signed-in user wants `category` on `channel`. Before the
   * stored matrix loads this answers with the catalog default. Ids outside
   * the catalog are not user-configurable and always pass.
   */
  function isNotificationChannelEnabled(category: string, channel: NotificationChannel): boolean {
    if (deps.currentOwner() !== state.owner) return catalogDefaults()[category]?.[channel] ?? true;
    return getSnapshot().prefs[category]?.[channel] ?? true;
  }

  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getSnapshot,
    loadNotificationPrefs,
    saveNotificationPrefs,
    isNotificationChannelEnabled,
    resetNotificationPrefsStoreForTests() {
      state = fresh(null);
      emit();
    },
  };
}

/**
 * Catalog categories a notification payload belongs to. An explicit
 * `category` wins (server fan-out pushes and Hub Chat notices carry it);
 * otherwise the push `event` / `type` key maps through the catalog. Empty
 * when the payload is not a catalog notification.
 */
export function categoriesForNotificationData(data: any): string[] {
  if (!data || typeof data !== 'object') return [];
  if (isNotificationCategoryId(data.category)) return [data.category];
  const key =
    typeof data.event === 'string' ? data.event : typeof data.type === 'string' ? data.type : null;
  if (!key) return [];
  if (Object.prototype.hasOwnProperty.call(PUSH_EVENT_CATEGORIES, key)) {
    return [...PUSH_EVENT_CATEGORIES[key as PushEventType]];
  }
  return isNotificationCategoryId(key) ? [key] : [];
}

/**
 * Foreground banner gate. A banner shown while the app is open is an in-app
 * notification, so it follows the `in_app` pref. A payload spanning several
 * categories (a `chat_message` without a category) shows when any of them is
 * on; payloads outside the catalog always show.
 */
export function foregroundBannerAllowed(
  data: any,
  isEnabled: (category: string, channel: NotificationChannel) => boolean,
): boolean {
  const categories = categoriesForNotificationData(data);
  if (!categories.length) return true;
  return categories.some((c) => isEnabled(c, 'in_app'));
}
