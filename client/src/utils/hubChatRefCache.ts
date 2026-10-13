import { useEffect, useRef, useSyncExternalStore } from 'react';
import { api } from './api';
import { refKey, type HubChatResolvedRef } from '@shared/utils/hubChatRefs';

/**
 * Viewer-scoped detail for chat ref chips (card column, PR state, session
 * state), shared by every message on screen. Refs are requested in one batch
 * per render pass and kept for `TTL_MS`. Every mounted message re-checks its
 * refs each `REFRESH_TICK_MS`, so a status refreshes once it goes stale and a
 * failed lookup is retried, without a request per chip per tick.
 */
const TTL_MS = 60_000;
export const REFRESH_TICK_MS = 15_000;
const BATCH_MAX = 200;

interface Entry {
  ref: HubChatResolvedRef;
  at: number;
}

let entries = new Map<string, Entry>();
const inFlight = new Set<string>();
const listeners = new Set<() => void>();
let version = 0;
let queued: { kind: string; targetId: string }[] = [];
let flushScheduled = false;

function notify() {
  version += 1;
  for (const l of listeners) l();
}

async function flush() {
  flushScheduled = false;
  const batch = queued.slice(0, BATCH_MAX);
  queued = queued.slice(BATCH_MAX);
  if (queued.length > 0) schedule();
  if (batch.length === 0) return;
  try {
    const res = await api.hubChat.resolveRefs(batch);
    const now = Date.now();
    const next = new Map(entries);
    for (const ref of (res?.refs ?? []) as HubChatResolvedRef[]) {
      next.set(refKey(ref.kind, ref.targetId), { ref, at: now });
    }
    entries = next;
  } catch {
    // Chips fall back to their label; the next render retries.
  } finally {
    for (const r of batch) inFlight.delete(refKey(r.kind, r.targetId));
    notify();
  }
}

function schedule() {
  if (flushScheduled) return;
  flushScheduled = true;
  queueMicrotask(() => void flush());
}

/** Queues refs that are missing or stale. */
export function requestHubChatRefs(refs: { kind: string; targetId: string }[]): void {
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

export function getHubChatRef(kind: string, targetId: string): HubChatResolvedRef | null {
  return entries.get(refKey(kind, targetId))?.ref ?? null;
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * Subscribes to the cache and requests `refs` (missing or stale ones) after
 * render. Returns a version number that changes whenever results land.
 */
export function useHubChatRefs(refs: { kind: string; targetId: string }[]): number {
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
    requestHubChatRefs(refsRef.current);
    const timer = setInterval(() => requestHubChatRefs(refsRef.current), REFRESH_TICK_MS);
    return () => clearInterval(timer);
  }, [key]);
  return v;
}

export function resetHubChatRefCacheForTests(): void {
  entries = new Map();
  inFlight.clear();
  queued = [];
  flushScheduled = false;
  notify();
}
