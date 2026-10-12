import { describe, expect, it, vi } from 'vitest';
import {
  addAnnouncement,
  chatBadgeCount,
  createChatMuteStore,
  isSpaceQuiet,
} from './googleChatMutes';

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function makeApi() {
  return {
    getGoogleChatMutes: vi.fn(async (): Promise<any> => ({ spaceIds: [], revision: 0 })),
    setGoogleChatSpaceMuted: vi.fn(async (_id: string, _m: boolean): Promise<any> => ({})),
  };
}

const ids = (store: ReturnType<typeof createChatMuteStore>) => [...store.getState().spaceIds];

describe('chat mute store', () => {
  it('loads the server list', async () => {
    const api = makeApi();
    api.getGoogleChatMutes.mockResolvedValue({ spaceIds: ['A', 'B'], revision: 2 });
    const store = createChatMuteStore(api);
    expect(await store.load()).toBe(true);
    expect(ids(store)).toEqual(['A', 'B']);
  });

  it('stays unloaded when the load fails', async () => {
    const api = makeApi();
    api.getGoogleChatMutes.mockRejectedValue(new Error('offline'));
    const store = createChatMuteStore(api);
    expect(await store.load()).toBe(false);
  });

  it('shows a write right away and takes the server list when it lands', async () => {
    const api = makeApi();
    const reply = deferred<any>();
    api.setGoogleChatSpaceMuted.mockReturnValue(reply.promise);
    const store = createChatMuteStore(api);
    await store.load();
    const done = store.setMuted('A', true);
    expect(ids(store)).toEqual(['A']);
    reply.resolve({ spaceIds: ['A', 'Z'], revision: 2, googleSync: 'synced' });
    expect((await done).googleSync).toBe('synced');
    expect(ids(store)).toEqual(['A', 'Z']);
  });

  it('rolls back a failed write to the server value', async () => {
    const api = makeApi();
    api.setGoogleChatSpaceMuted.mockRejectedValue(new Error('offline'));
    const store = createChatMuteStore(api);
    await store.load();
    await expect(store.setMuted('A', true)).rejects.toThrow('offline');
    expect(ids(store)).toEqual([]);
  });

  it('keeps the newer load when an older one answers last', async () => {
    const api = makeApi();
    const first = deferred<any>();
    const second = deferred<any>();
    api.getGoogleChatMutes.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const store = createChatMuteStore(api);
    const initial = store.load();
    const reconnect = store.load();
    second.resolve({ spaceIds: ['NEW'], revision: 5 });
    await reconnect;
    first.resolve({ spaceIds: ['OLD'], revision: 4 });
    await initial;
    expect(ids(store)).toEqual(['NEW']);
  });

  it('a load that read the list before a write committed cannot undo the write', async () => {
    const api = makeApi();
    const put = deferred<any>();
    const get = deferred<any>();
    api.setGoogleChatSpaceMuted.mockReturnValue(put.promise);
    const store = createChatMuteStore(api);
    await store.load();
    api.getGoogleChatMutes.mockReturnValue(get.promise);

    const write = store.setMuted('A', true);
    const load = store.load();
    // The PUT commits and answers first; the GET had read the old list.
    put.resolve({ spaceIds: ['A'], revision: 1 });
    await write;
    get.resolve({ spaceIds: [], revision: 0 });
    await load;
    expect(ids(store)).toEqual(['A']);
  });

  it('a stale list arriving while a write is pending does not hide the pending value', async () => {
    const api = makeApi();
    const put = deferred<any>();
    api.setGoogleChatSpaceMuted.mockReturnValue(put.promise);
    const store = createChatMuteStore(api);
    await store.load();
    const write = store.setMuted('A', true);
    store.applyEvent({ spaceIds: ['B'], revision: 1 });
    expect(ids(store).sort()).toEqual(['A', 'B']);
    put.resolve({ spaceIds: ['B', 'A'], revision: 2 });
    await write;
    expect(ids(store).sort()).toEqual(['A', 'B']);
  });

  it('ignores pushes without a revision and older pushes', async () => {
    const store = createChatMuteStore(makeApi());
    store.applyEvent({ spaceIds: ['A'], revision: 3 });
    store.applyEvent({ spaceIds: [], revision: 2 });
    store.applyEvent({ spaceIds: [] });
    expect(ids(store)).toEqual(['A']);
  });

  it("drops a previous account's answers after reset", async () => {
    const api = makeApi();
    const get = deferred<any>();
    api.getGoogleChatMutes.mockReturnValue(get.promise);
    const store = createChatMuteStore(api);
    const load = store.load();
    store.reset();
    get.resolve({ spaceIds: ['A'], revision: 9 });
    await load;
    expect(store.getState().loaded).toBe(false);
  });
});

describe('chatBadgeCount', () => {
  const loaded = (muted: string[] = []) => ({ loaded: true, spaceIds: new Set(muted) });

  it('uses announced messages when push is off, and push counts when it is on', () => {
    const announced = addAnnouncement(addAnnouncement({}, { spaceId: 'A', count: 2 }), {
      spaceId: 'B',
      count: 1,
    });
    expect(chatBadgeCount(false, {}, announced, loaded())).toBe(3);
    expect(chatBadgeCount(true, { 'spaces/A': { count: 5 } }, announced, loaded())).toBe(5);
  });

  it('a mute from another tab removes what the space already added to the fallback badge', () => {
    const store = createChatMuteStore(makeApi());
    store.applyEvent({ spaceIds: [], revision: 1 });
    let announced: Record<string, number> = {};
    announced = addAnnouncement(announced, { spaceId: 'A', count: 2 });
    announced = addAnnouncement(announced, { spaceId: 'B', count: 1 });
    expect(chatBadgeCount(false, {}, announced, store.getState())).toBe(3);

    store.applyEvent({ spaceIds: ['A'], revision: 2 });
    expect(chatBadgeCount(false, {}, announced, store.getState())).toBe(1);
    expect(chatBadgeCount(true, { 'spaces/A': { count: 4 } }, announced, store.getState())).toBe(0);
  });

  it('isSpaceQuiet holds every space quiet until the list loads', () => {
    expect(isSpaceQuiet({ loaded: false, spaceIds: new Set<string>() }, 'A')).toBe(true);
    expect(isSpaceQuiet({ loaded: true, spaceIds: new Set(['A']) }, 'A')).toBe(true);
    expect(isSpaceQuiet({ loaded: true, spaceIds: new Set(['A']) }, 'B')).toBe(false);
  });

  it('stays at zero until the mute list loads', () => {
    expect(
      chatBadgeCount(false, {}, { A: 2 }, { loaded: false, spaceIds: new Set<string>() }),
    ).toBe(0);
  });
});
