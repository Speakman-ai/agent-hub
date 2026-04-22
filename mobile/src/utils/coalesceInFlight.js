/**
 * Coalesce concurrent async work per key. Callers with the same key await
 * the same promise; only the first invocation runs `start`.
 *
 * @param {{ current: Map<string, Promise<unknown>> }} mapRef
 * @param {string} key
 * @param {() => Promise<unknown>} start
 * @returns {Promise<unknown>}
 */
export function coalescePromiseByKey(mapRef, key, start) {
  const m = mapRef.current;
  const existing = m.get(key);
  if (existing) return existing;
  const p = start();
  m.set(key, p);
  void p
    .finally(() => {
      if (mapRef.current.get(key) === p) {
        mapRef.current.delete(key);
      }
    })
    .catch(() => {});
  return p;
}
