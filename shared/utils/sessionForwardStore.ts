/**
 * Dispatch state for Session forward cards, kept outside React.
 *
 * A card component can unmount while its dispatch is still in flight (the
 * user navigates away and back). State on the component would be lost and the
 * remounted card would offer Session forward again. The store is a module
 * singleton per client, keyed by card identity, so a remount sees the pending
 * claim and later the result.
 */
export type SessionForwardEntry<R> =
  | { status: 'pending' }
  | { status: 'done'; record: R }
  | { status: 'failed'; message: string };

export interface SessionForwardStore<R> {
  get(key: string): SessionForwardEntry<R> | undefined;
  /** Take the dispatch for `key`. False while one is pending or after it succeeded. */
  claim(key: string): boolean;
  succeed(key: string, record: R): void;
  fail(key: string, message: string): void;
  subscribe(key: string, listener: () => void): () => void;
  clear(): void;
}

export function createSessionForwardStore<R>(): SessionForwardStore<R> {
  const entries = new Map<string, SessionForwardEntry<R>>();
  const listeners = new Map<string, Set<() => void>>();

  const set = (key: string, entry: SessionForwardEntry<R>) => {
    entries.set(key, entry);
    for (const listener of [...(listeners.get(key) ?? [])]) listener();
  };

  return {
    get: (key) => entries.get(key),
    claim(key) {
      const current = entries.get(key);
      if (current && current.status !== 'failed') return false;
      set(key, { status: 'pending' });
      return true;
    },
    succeed: (key, record) => set(key, { status: 'done', record }),
    fail: (key, message) => set(key, { status: 'failed', message }),
    subscribe(key, listener) {
      const group = listeners.get(key) ?? new Set();
      group.add(listener);
      listeners.set(key, group);
      return () => {
        group.delete(listener);
        if (group.size === 0) listeners.delete(key);
      };
    },
    clear() {
      const keys = [...entries.keys()];
      entries.clear();
      for (const key of keys) for (const listener of [...(listeners.get(key) ?? [])]) listener();
    },
  };
}
