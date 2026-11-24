/**
 * Client view of Orchestrate Auto start, shared by web and mobile.
 *
 * The server is the only source of truth: it holds each chat's Default build
 * and Auto start setting, runs the forward-card countdowns, and keeps cancels.
 * This module only mirrors what the server reports (a load, a save's
 * response, WebSocket events) and makes the three calls the UI needs. It
 * keeps nothing in device storage and queues nothing: a failed save or
 * cancel rejects, and the caller shows the error.
 */
import type { SessionForwardMode } from './extractForwardBlocks.js';
import {
  parseSessionForwardDispatchKey,
  sessionForwardDispatchKey,
} from './sessionForwardDispatchKey.js';

/** How long the server waits after a turn before starting its forward cards. */
export const ORCHESTRATE_AUTO_START_SECONDS = 30;

export const ORCHESTRATE_LAUNCH_UPDATED_EVENT = 'orchestrate_launch_updated';
export const ORCHESTRATE_AUTO_START_SCHEDULED_EVENT = 'orchestrate_auto_start_scheduled';
/** A forward card started a session, by a press or by the server's countdown. */
export const SESSION_FORWARD_STARTED_EVENT = 'session_forward_started';
/** A server countdown ended without starting its card (failed, ineligible, or Auto start off). */
export const ORCHESTRATE_AUTO_START_ENDED_EVENT = 'orchestrate_auto_start_ended';
export const ORCHESTRATE_AUTO_START_CANCELLED_EVENT = 'orchestrate_auto_start_cancelled';

export interface OrchestrateLaunchSettingsView {
  mode: SessionForwardMode;
  autoStart: boolean;
  /** Server save counter; a lower one is older and ignored. */
  revision: number;
}

export interface ServerStartedForward {
  sessionId: string;
  agentId: string;
  name: string;
  mode: string;
}

export interface ForwardCardRef {
  messageId: string | number;
  forwardId: string;
  occurrence: number;
}

export interface OrchestrateLaunchSnapshot {
  settings: { mode: SessionForwardMode; autoStart: boolean; revision: number };
  launched?: Array<ServerStartedForward & { dispatchKey: string }>;
  cancelled?: string[];
  pending?: Array<{ dispatchKey: string; remainingMs: number }>;
}

export interface OrchestrateLaunchApi {
  getOrchestrateLaunch(sessionId: string): Promise<OrchestrateLaunchSnapshot>;
  putOrchestrateLaunch(
    sessionId: string,
    patch: { mode?: SessionForwardMode; autoStart?: boolean },
  ): Promise<{ settings?: OrchestrateLaunchSnapshot['settings'] }>;
  cancelOrchestrateAutoStart(sessionId: string, card: ForwardCardRef): Promise<unknown>;
}

type UseSyncExternalStore = <T>(
  subscribe: (listener: () => void) => () => void,
  getSnapshot: () => T,
  getServerSnapshot?: () => T,
) => T;

const BUILD_MODES: readonly SessionForwardMode[] = ['manual', 'review', 'push', 'merge'];

function settingsFrom(raw: unknown): OrchestrateLaunchSettingsView | null {
  const value = raw as { mode?: unknown; autoStart?: unknown; revision?: unknown } | null;
  if (!value || typeof value.revision !== 'number') return null;
  const mode = BUILD_MODES.includes(value.mode as SessionForwardMode)
    ? (value.mode as SessionForwardMode)
    : 'manual';
  return { mode, autoStart: value.autoStart === true, revision: value.revision };
}

export function createOrchestrateLaunchClient(deps: {
  api: OrchestrateLaunchApi;
  useSyncExternalStore: UseSyncExternalStore;
  now?: () => number;
}) {
  const { api, useSyncExternalStore } = deps;
  const now = deps.now ?? (() => Date.now());
  const settings = new Map<string, OrchestrateLaunchSettingsView>();
  const started = new Map<string, ServerStartedForward>();
  const cancelled = new Set<string>();
  // When the server will start each card, on this device's clock.
  const deadlines = new Map<string, number>();
  const loads = new Map<string, Promise<void>>();
  // Countdowns changed by WebSocket events while a load of their chat is in
  // flight, per chat. Events arrive in the order the server sent them, so
  // each is at least as new as the load's answer, which must not overwrite
  // them. Countdowns change only through their own per-card events (the
  // server sends an ended event for each one it stops, including when Auto
  // start is turned off); settings changes never touch them here.
  const touchedDuringLoad = new Map<string, Set<string>>();
  const noteTouched = (sessionId: string | null | undefined, key: string) => {
    if (sessionId) touchedDuringLoad.get(sessionId)?.add(key);
  };
  // Chats in Orchestrate right now; cards only count down there.
  const orchestrating = new Set<string>();
  const listeners = new Map<string, Set<() => void>>();

  const notify = (key: string) => {
    for (const listener of [...(listeners.get(key) ?? [])]) listener();
  };
  const subscribe = (key: string | null, listener: () => void) => {
    if (!key) return () => {};
    const group = listeners.get(key) ?? new Set();
    group.add(listener);
    listeners.set(key, group);
    return () => {
      group.delete(listener);
      if (group.size === 0) listeners.delete(key);
    };
  };
  const settingsKey = (sessionId: string) => `settings:${sessionId}`;

  /** Keep a server value unless one with a newer revision is already held. */
  function applySettings(sessionId: string, raw: unknown): void {
    const next = settingsFrom(raw);
    if (!next) return;
    const held = settings.get(sessionId);
    if (held && held.revision >= next.revision) return;
    settings.set(sessionId, next);
    notify(settingsKey(sessionId));
  }

  function dropCountdown(dispatchKey: string): void {
    if (dispatchKey && deadlines.delete(dispatchKey)) notify(dispatchKey);
  }

  /** Drop the chat's countdowns except the ones listed. */
  function dropCountdowns(sessionId: string, keep: ReadonlySet<string>): void {
    const prefix = `session-forward:${sessionId}:`;
    for (const key of [...deadlines.keys()]) {
      if (key.startsWith(prefix) && !keep.has(key)) dropCountdown(key);
    }
  }

  function markStarted(dispatchKey: string, record: ServerStartedForward): void {
    if (!dispatchKey || !record?.sessionId) return;
    started.set(dispatchKey, record);
    deadlines.delete(dispatchKey);
    notify(dispatchKey);
  }

  function markCancelled(dispatchKey: string): void {
    if (!dispatchKey) return;
    cancelled.add(dispatchKey);
    deadlines.delete(dispatchKey);
    notify(dispatchKey);
  }

  function markCountdown(dispatchKey: string, remainingMs: number): void {
    if (!dispatchKey || started.has(dispatchKey) || cancelled.has(dispatchKey)) return;
    deadlines.set(dispatchKey, now() + Math.max(0, remainingMs));
    notify(dispatchKey);
  }

  /** Load a chat's settings and cards. Concurrent calls share one request. */
  function load(sessionId: string): Promise<void> {
    const running = loads.get(sessionId);
    if (running) return running;
    const touched = new Set<string>();
    touchedDuringLoad.set(sessionId, touched);
    const run = (async () => {
      const snapshot = await api.getOrchestrateLaunch(sessionId);
      // Settings are ordered by revision; started and cancelled only ever
      // accumulate, so applying them late is always safe.
      applySettings(sessionId, snapshot.settings);
      for (const { dispatchKey, ...record } of snapshot.launched ?? []) {
        markStarted(dispatchKey, record);
      }
      for (const dispatchKey of snapshot.cancelled ?? []) markCancelled(dispatchKey);
      // Countdowns can go either way, so the snapshot settles only the ones no
      // event has touched since the request went out.
      const pending = (snapshot.pending ?? []).filter((p) => !touched.has(p.dispatchKey));
      dropCountdowns(sessionId, new Set([...pending.map((p) => p.dispatchKey), ...touched]));
      for (const { dispatchKey, remainingMs } of pending) markCountdown(dispatchKey, remainingMs);
    })().finally(() => {
      loads.delete(sessionId);
      if (touchedDuringLoad.get(sessionId) === touched) touchedDuringLoad.delete(sessionId);
    });
    loads.set(sessionId, run);
    return run;
  }

  /**
   * Reload every chat this client holds launch state for. Call when the
   * WebSocket (re)connects: events sent while it was down are gone, so a card
   * could otherwise wait on a start, cancel or settings change it missed. A
   * load already in flight was asked before the reconnect, so a fresh one
   * follows it.
   */
  function refreshAll(): Promise<void> {
    const chats = new Set<string>([...settings.keys(), ...orchestrating, ...loads.keys()]);
    for (const key of deadlines.keys()) {
      const chat = parseSessionForwardDispatchKey(key)?.sessionId;
      if (chat) chats.add(chat);
    }
    return Promise.all(
      [...chats].map((chat) =>
        (loads.get(chat) ?? Promise.resolve())
          .catch(() => {})
          .then(() => load(chat))
          .catch(() => {
            /* the panel offers a retry; the next reconnect tries again */
          }),
      ),
    ).then(() => {});
  }

  return {
    load,
    refreshAll,

    /** Save Default build or Auto start. Rejects when the server did not take it. */
    async save(
      sessionId: string,
      patch: { mode?: SessionForwardMode; autoStart?: boolean },
    ): Promise<void> {
      const response = await api.putOrchestrateLaunch(sessionId, patch);
      applySettings(sessionId, response?.settings);
    },

    /** Stop the server countdown for a card. Rejects when the server did not take it. */
    async cancel(sessionId: string, card: ForwardCardRef): Promise<void> {
      await api.cancelOrchestrateAutoStart(sessionId, card);
      const key = sessionForwardDispatchKey({ sessionId, ...card });
      if (key) markCancelled(key);
    },

    /** Feed any WebSocket event; the four launch events are picked out here. */
    handleEvent(data: unknown): void {
      const event = data as Record<string, unknown> | null;
      if (!event || typeof event.type !== 'string') return;
      const key = typeof event.dispatchKey === 'string' ? event.dispatchKey : '';
      const chat =
        parseSessionForwardDispatchKey(key)?.sessionId ??
        (typeof event.sessionId === 'string' ? event.sessionId : null);
      switch (event.type) {
        case ORCHESTRATE_LAUNCH_UPDATED_EVENT:
          if (chat) applySettings(chat, event.settings);
          return;
        case ORCHESTRATE_AUTO_START_SCHEDULED_EVENT:
          if (typeof event.remainingMs === 'number') markCountdown(key, event.remainingMs);
          break;
        case SESSION_FORWARD_STARTED_EVENT: {
          const s = event.started as Partial<ServerStartedForward> | undefined;
          if (s?.sessionId) {
            markStarted(key, {
              sessionId: String(s.sessionId),
              agentId: String(s.agentId ?? ''),
              name: String(s.name ?? ''),
              mode: String(s.mode ?? 'manual'),
            });
          }
          break;
        }
        case ORCHESTRATE_AUTO_START_CANCELLED_EVENT:
          markCancelled(key);
          break;
        case ORCHESTRATE_AUTO_START_ENDED_EVENT:
          dropCountdown(key);
          break;
        default:
          return;
      }
      noteTouched(chat, key);
    },

    /** The chat's server settings, or null until they have loaded. */
    useSettings(sessionId: string | null | undefined): OrchestrateLaunchSettingsView | null {
      const key = sessionId ? settingsKey(sessionId) : null;
      return useSyncExternalStore(
        (listener) => subscribe(key, listener),
        () => (sessionId ? (settings.get(sessionId) ?? null) : null),
        () => null,
      );
    },
    getSettings: (sessionId: string): OrchestrateLaunchSettingsView | null =>
      settings.get(sessionId) ?? null,

    /** When the server will start this card (this device's clock), or null. */
    useDeadline(dispatchKey: string | null): number | null {
      return useSyncExternalStore(
        (listener) => subscribe(dispatchKey, listener),
        () => (dispatchKey ? (deadlines.get(dispatchKey) ?? null) : null),
        () => null,
      );
    },
    getDeadline: (dispatchKey: string): number | null => deadlines.get(dispatchKey) ?? null,

    useCancelled(dispatchKey: string | null): boolean {
      return useSyncExternalStore(
        (listener) => subscribe(dispatchKey, listener),
        () => Boolean(dispatchKey && cancelled.has(dispatchKey)),
        () => false,
      );
    },

    /** The session the server started for this card, or null. */
    useStarted(dispatchKey: string | null): ServerStartedForward | null {
      return useSyncExternalStore(
        (listener) => subscribe(dispatchKey, listener),
        () => (dispatchKey ? (started.get(dispatchKey) ?? null) : null),
        () => null,
      );
    },

    /** Publish whether a chat is in Orchestrate mode right now. */
    setSessionActive(sessionId: string, active: boolean): void {
      if (orchestrating.has(sessionId) === active) return;
      if (active) orchestrating.add(sessionId);
      else orchestrating.delete(sessionId);
      notify(`active:${sessionId}`);
    },
    useSessionActive(sessionId: string | null | undefined): boolean {
      const key = sessionId ? `active:${sessionId}` : null;
      return useSyncExternalStore(
        (listener) => subscribe(key, listener),
        () => Boolean(sessionId && orchestrating.has(sessionId)),
        () => false,
      );
    },

    resetForTests(): void {
      orchestrating.clear();
      settings.clear();
      started.clear();
      cancelled.clear();
      deadlines.clear();
      loads.clear();
      touchedDuringLoad.clear();
      listeners.clear();
    },
  };
}

export type OrchestrateLaunchClient = ReturnType<typeof createOrchestrateLaunchClient>;
