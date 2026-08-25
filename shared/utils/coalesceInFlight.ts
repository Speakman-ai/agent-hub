/**
 * Coalesce concurrent async work per key, shared by the web (`client/src/App.tsx`)
 * and mobile (`mobile/src/context/AppContext.tsx`) implicit-session-create paths.
 * Callers with the same key await the same promise; only the first invocation
 * runs `start`. The slot clears once the promise settles, so a later call for
 * the same key starts fresh work.
 *
 * Pure: no React import. `mapRef` is typed structurally so a `useRef` from
 * either platform's React satisfies it.
 */

export function coalescePromiseByKey<K, T>(
  mapRef: { current: Map<K, Promise<T>> },
  key: K,
  start: () => Promise<T>,
): Promise<T> {
  const existing = mapRef.current.get(key);
  if (existing) return existing;
  const p = start();
  mapRef.current.set(key, p);
  // Avoid an unhandled rejection on the cleanup chain; callers still await `p`.
  void p
    .finally(() => {
      if (mapRef.current.get(key) === p) {
        mapRef.current.delete(key);
      }
    })
    .catch(() => {});
  return p;
}
