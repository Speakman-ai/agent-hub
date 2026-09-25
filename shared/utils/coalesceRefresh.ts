export interface PendingRefresh {
  promise: Promise<void>;
  queued: boolean;
}

/** Serialize refreshes per key, retaining invalidations received during a read. */
export function coalesceRefreshByKey<K>(
  mapRef: { current: Map<K, PendingRefresh> },
  key: K,
  refresh: () => Promise<void>,
): Promise<void> {
  const existing = mapRef.current.get(key);
  if (existing) {
    existing.queued = true;
    return existing.promise;
  }

  const pending: PendingRefresh = { promise: Promise.resolve(), queued: false };
  mapRef.current.set(key, pending);
  pending.promise = (async () => {
    try {
      do {
        pending.queued = false;
        await refresh();
      } while (pending.queued);
    } finally {
      mapRef.current.delete(key);
    }
  })();
  return pending.promise;
}
