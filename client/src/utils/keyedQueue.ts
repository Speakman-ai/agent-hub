/**
 * Runs async tasks one at a time per key, each after the previous task for
 * that key settled (success or failure). Used where overlapping requests that
 * change the same server state would otherwise apply their results in
 * whatever order the responses arrive.
 */
export function createKeyedQueue() {
  const chains = new Map<string, Promise<unknown>>();
  return function run<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = chains.get(key) ?? Promise.resolve();
    const result = previous.then(task, task);
    const settled = result.then(
      () => undefined,
      () => undefined,
    );
    chains.set(key, settled);
    void settled.then(() => {
      if (chains.get(key) === settled) chains.delete(key);
    });
    return result;
  };
}
