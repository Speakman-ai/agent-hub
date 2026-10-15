/**
 * Client-side owner of the caller's notification preferences.
 *
 * Load and save state lives here rather than in the settings view so pending
 * saves keep draining after the view unmounts (switching settings tabs must
 * not discard a queued toggle).
 *
 * Saves are serialized: at most one PUT is in flight, and edits made while it
 * runs are coalesced into `queued` and sent once it settles. Responses arrive
 * in order, so the newest one is the server's current state. The displayed
 * matrix is that confirmed state with in-flight and queued edits on top.
 */
import {
  NOTIFICATION_SECTIONS,
  type NotificationChannel,
} from '@shared/utils/notificationCategories';
import { api, type NotificationPreferencesPatch, type NotificationPreferencesWire } from './api';
import { getUserEmail } from './auth';

export type ChannelValues = Record<NotificationChannel, boolean>;
export type PrefsMap = Record<string, ChannelValues>;

export interface NotificationPrefsState {
  loaded: boolean;
  loading: boolean;
  error: string | null;
  prefs: PrefsMap;
}

interface Internal {
  owner: string | null;
  loaded: boolean;
  loading: boolean;
  error: string | null;
  confirmed: PrefsMap;
  inflight: NotificationPreferencesPatch | null;
  queued: NotificationPreferencesPatch;
  /** Bumped whenever a save is accepted; a GET started before it is stale. */
  saveGen: number;
}

function catalogDefaults(): PrefsMap {
  const out: PrefsMap = {};
  for (const s of NOTIFICATION_SECTIONS) {
    for (const c of s.categories) out[c.id] = { ...c.defaults };
  }
  return out;
}

export function applyPatch(prefs: PrefsMap, patch: NotificationPreferencesPatch): PrefsMap {
  const next = { ...prefs };
  for (const [category, channels] of Object.entries(patch)) {
    next[category] = { ...next[category], ...channels } as ChannelValues;
  }
  return next;
}

function mergePatch(
  a: NotificationPreferencesPatch,
  b: NotificationPreferencesPatch,
): NotificationPreferencesPatch {
  const out: NotificationPreferencesPatch = { ...a };
  for (const [category, channels] of Object.entries(b)) {
    out[category] = { ...out[category], ...channels };
  }
  return out;
}

function fromResponse(res: NotificationPreferencesWire): NotificationPreferencesPatch {
  const out: NotificationPreferencesPatch = {};
  for (const c of res.categories) {
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

const currentOwner = () => getUserEmail() ?? null;

let state: Internal = fresh(null);
let snapshot: NotificationPrefsState | null = null;
const listeners = new Set<() => void>();

function emit() {
  snapshot = null;
  for (const l of listeners) l();
}

/** A different signed-in user must never see or send the previous user's edits. */
function ensureOwner() {
  const owner = currentOwner();
  if (owner !== state.owner) {
    state = fresh(owner);
    snapshot = null;
  }
}

export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getSnapshot(): NotificationPrefsState {
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
 * save is pending, and the result is dropped if a save was accepted after the
 * GET started, since that save's response is newer.
 */
export function loadNotificationPrefs(): void {
  ensureOwner();
  if (state.loading) return;
  if (state.loaded && (state.inflight || Object.keys(state.queued).length)) return;
  const target = state;
  const gen = state.saveGen;
  target.loading = true;
  emit();
  api
    .getNotificationPreferences()
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
      if (!target.loaded) target.error = err?.message || 'Failed to load notification preferences';
    })
    .finally(() => {
      if (state !== target) return;
      target.loading = false;
      emit();
    });
}

function drain(target: Internal) {
  if (state !== target || target.inflight || !Object.keys(target.queued).length) return;
  if (currentOwner() !== target.owner) {
    state = fresh(currentOwner());
    emit();
    return;
  }
  const patch = target.queued;
  target.inflight = patch;
  target.queued = {};
  emit();
  api
    .updateNotificationPreferences(patch)
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
export function saveNotificationPrefs(patch: NotificationPreferencesPatch): void {
  ensureOwner();
  if (!state.loaded) return;
  state.error = null;
  state.queued = mergePatch(state.queued, patch);
  state.saveGen += 1;
  emit();
  drain(state);
}

export function resetNotificationPrefsStoreForTests(): void {
  state = fresh(null);
  emit();
}

/**
 * Whether the signed-in user wants `category` on `channel`. Before the stored
 * matrix loads this answers with the catalog default. Ids outside the catalog
 * are not user-configurable and always pass.
 */
export function isNotificationChannelEnabled(
  category: string,
  channel: NotificationChannel,
): boolean {
  if (currentOwner() !== state.owner) return catalogDefaults()[category]?.[channel] ?? true;
  return getSnapshot().prefs[category]?.[channel] ?? true;
}
