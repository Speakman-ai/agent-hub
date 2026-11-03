import { describe, expect, it, vi } from 'vitest';
import { createSessionForwardStore } from './sessionForwardStore.js';

describe('createSessionForwardStore', () => {
  it('allows one claim per key until it fails', () => {
    const store = createSessionForwardStore<string>();
    expect(store.claim('a')).toBe(true);
    expect(store.claim('a')).toBe(false);
    expect(store.claim('b')).toBe(true);
    store.fail('a', 'boom');
    expect(store.get('a')).toEqual({ status: 'failed', message: 'boom' });
    expect(store.claim('a')).toBe(true);
    store.succeed('a', 'sess-1');
    expect(store.claim('a')).toBe(false);
    expect(store.get('a')).toEqual({ status: 'done', record: 'sess-1' });
  });

  it('notifies only the subscribers of the changed key', () => {
    const store = createSessionForwardStore<string>();
    const onA = vi.fn();
    const onB = vi.fn();
    const stopA = store.subscribe('a', onA);
    store.subscribe('b', onB);
    store.claim('a');
    expect(onA).toHaveBeenCalledTimes(1);
    expect(onB).not.toHaveBeenCalled();
    stopA();
    store.succeed('a', 'x');
    expect(onA).toHaveBeenCalledTimes(1);
  });

  it('clear drops every entry', () => {
    const store = createSessionForwardStore<string>();
    store.claim('a');
    store.clear();
    expect(store.get('a')).toBeUndefined();
    expect(store.claim('a')).toBe(true);
  });
});
