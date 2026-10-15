import { createUnreadSpacesStore, unreadSpacesKey } from './googleChatUnreadSpaces';

function memoryStorage(): Storage {
  const data = new Map<string, string>();
  return {
    get length() {
      return data.size;
    },
    clear: () => data.clear(),
    getItem: (k) => data.get(k) ?? null,
    key: (i) => [...data.keys()][i] ?? null,
    removeItem: (k) => void data.delete(k),
    setItem: (k, v) => void data.set(k, String(v)),
  };
}

describe('google chat unread spaces store', () => {
  it('publishes, persists per user, and reloads', () => {
    const storage = memoryStorage();
    const store = createUnreadSpacesStore(storage);
    store.publish('u1', ['A', 'B']);
    expect([...store.get('u1')]).toEqual(['A', 'B']);
    expect(store.get('u2').size).toBe(0);
    expect(JSON.parse(storage.getItem(unreadSpacesKey('u1'))!)).toEqual(['A', 'B']);
    expect([...createUnreadSpacesStore(storage).get('u1')]).toEqual(['A', 'B']);
  });

  it('keeps prior membership for unknown spaces and drops the rest', () => {
    const store = createUnreadSpacesStore(memoryStorage());
    store.publish('u1', ['A', 'B', 'C']);
    store.publish('u1', ['D'], ['B', 'E']);
    expect([...store.get('u1')].sort()).toEqual(['B', 'D']);
  });

  it('marks an announced space unread and notifies only on change', () => {
    const store = createUnreadSpacesStore(memoryStorage());
    const listener = vi.fn();
    store.subscribe(listener);
    store.markUnread('u1', 'A');
    store.markUnread('u1', 'A');
    store.publish('u1', ['A']);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(store.get('u1').has('A')).toBe(true);
  });

  it('picks up a set another tab wrote after the first read', () => {
    const storage = memoryStorage();
    const events = new EventTarget();
    const store = createUnreadSpacesStore(storage, events);
    store.markUnread('u1', 'B');
    const listener = vi.fn();
    store.subscribe(listener);

    // Tab C reads B and publishes an empty set to shared storage.
    storage.setItem(unreadSpacesKey('u1'), '[]');
    expect(store.get('u1').has('B')).toBe(true);
    events.dispatchEvent(Object.assign(new Event('storage'), { key: unreadSpacesKey('u1') }));

    expect(listener).toHaveBeenCalledTimes(1);
    expect(store.get('u1').size).toBe(0);
  });

  it('ignores storage events for other keys and reloads everything on clear', () => {
    const storage = memoryStorage();
    const events = new EventTarget();
    const store = createUnreadSpacesStore(storage, events);
    store.markUnread('u1', 'A');
    const listener = vi.fn();
    store.subscribe(listener);
    events.dispatchEvent(Object.assign(new Event('storage'), { key: 'something.else' }));
    expect(listener).not.toHaveBeenCalled();

    storage.clear();
    events.dispatchEvent(Object.assign(new Event('storage'), { key: null }));
    expect(listener).toHaveBeenCalledTimes(1);
    expect(store.get('u1').size).toBe(0);
  });

  it('ignores a corrupt stored value', () => {
    const storage = memoryStorage();
    storage.setItem(unreadSpacesKey(null), '{not json');
    expect(createUnreadSpacesStore(storage).get(null).size).toBe(0);
  });
});
