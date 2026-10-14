/**
 * Viewer-scoped detail for chat ref chips (card column, PR state, session
 * state), shared by every message on screen; one cache per client, created
 * with that client's resolve request (`POST /api/chat/refs/resolve`).
 *
 * Refs are requested in one batch per render pass and kept for `TTL_MS`.
 * Every mounted message re-checks its refs each `REFRESH_TICK_MS`, so a
 * status refreshes once it goes stale and a failed lookup is retried, without
 * a request per chip per tick.
 *
 * Resolved refs are what one viewer may see, so a cache belongs to one
 * account, server and org: `reset` clears it on any identity change and bumps
 * a generation, so a lookup in flight for the previous viewer is dropped
 * instead of filling the new viewer's cache.
 */
import { refKey, type HubChatResolvedRef } from './hubChatRefs';

const TTL_MS = 60_000;
export const REFRESH_TICK_MS = 15_000;
const BATCH_MAX = 200;

/** React hooks, injected: web and native install different React versions. */
export type HubChatRefCacheHooks = {
  useSyncExternalStore: <T>(
    subscribe: (onChange: () => void) => () => void,
    getSnapshot: () => T,
    getServerSnapshot?: () => T,
  ) => T;
  useEffect: (effect: () => void | (() => void), deps?: readonly unknown[]) => void;
  useRef: <T>(initial: T) => { current: T };
};

export type HubChatRefResolver = (
  refs: { kind: string; targetId: string }[],
) => Promise<{ refs?: HubChatResolvedRef[] } | undefined>;

export function createHubChatRefCache(
  resolve: HubChatRefResolver,
  { useSyncExternalStore, useEffect, useRef }: HubChatRefCacheHooks,
) {
  let entries = new Map<string, { ref: HubChatResolvedRef; at: number }>();
  const inFlight = new Set<string>();
  const listeners = new Set<() => void>();
  let version = 0;
  let queued: { kind: string; targetId: string }[] = [];
  let flushScheduled = false;
  let generation = 0;

  const notify = () => {
    version += 1;
    for (const l of listeners) l();
  };

  async function flush() {
    flushScheduled = false;
    const batch = queued.slice(0, BATCH_MAX);
    queued = queued.slice(BATCH_MAX);
    if (queued.length > 0) schedule();
    if (batch.length === 0) return;
    const gen = generation;
    try {
      const res = await resolve(batch);
      if (gen !== generation) return;
      const now = Date.now();
      const next = new Map(entries);
      for (const ref of res?.refs ?? []) {
        next.set(refKey(ref.kind, ref.targetId), { ref, at: now });
      }
      entries = next;
    } catch {
      // Chips fall back to their label; the next render retries.
    } finally {
      if (gen === generation) {
        for (const r of batch) inFlight.delete(refKey(r.kind, r.targetId));
        notify();
      }
    }
  }

  function schedule() {
    if (flushScheduled) return;
    flushScheduled = true;
    queueMicrotask(() => void flush());
  }

  /** Queues refs that are missing or stale. */
  function request(refs: { kind: string; targetId: string }[]): void {
    const now = Date.now();
    let added = false;
    for (const r of refs) {
      const key = refKey(r.kind, r.targetId);
      if (inFlight.has(key)) continue;
      const hit = entries.get(key);
      if (hit && now - hit.at < TTL_MS) continue;
      inFlight.add(key);
      queued.push({ kind: r.kind, targetId: r.targetId });
      added = true;
    }
    if (added) schedule();
  }

  function get(kind: string, targetId: string): HubChatResolvedRef | null {
    return entries.get(refKey(kind, targetId))?.ref ?? null;
  }

  function subscribe(listener: () => void) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  /** Forgets every resolved ref; call whenever the account, server or org changes. */
  function reset(): void {
    generation += 1;
    entries = new Map();
    inFlight.clear();
    queued = [];
    notify();
  }

  /**
   * Subscribes to the cache and requests `refs` (missing or stale ones) after
   * render. Returns a version number that changes whenever results land.
   */
  function useRefs(refs: { kind: string; targetId: string }[]): number {
    const v = useSyncExternalStore(
      subscribe,
      () => version,
      () => version,
    );
    const key = refs.map((r) => refKey(r.kind, r.targetId)).join('|');
    const refsRef = useRef(refs);
    refsRef.current = refs;
    useEffect(() => {
      if (!key) return;
      request(refsRef.current);
      const timer = setInterval(() => request(refsRef.current), REFRESH_TICK_MS);
      return () => clearInterval(timer);
    }, [key]);
    return v;
  }

  return { request, get, reset, useRefs };
}

export type HubChatRefCache = ReturnType<typeof createHubChatRefCache>;
