import { describe, expect, it, vi } from 'vitest';
import type { HubChatMessage } from '@shared/utils/hubChat';
import {
  admitNewMessages,
  CHANNEL_PAGE,
  MAX_PAGES_PER_BATCH,
  catchUpStart,
  createChannelSync,
  type ChannelPage,
} from './hubChatChannelSync';

function msg(seq: number, over: Partial<HubChatMessage> = {}): HubChatMessage {
  return {
    id: `m${seq}`,
    channelId: 'c1',
    seq,
    authorKind: 'user',
    authorUserId: 'u2',
    authorAgentId: null,
    body: `body ${seq}`,
    refs: [],
    payload: null,
    editedAt: null,
    deletedAt: null,
    createdAt: '2026-10-13T10:00:00Z',
    ...over,
  };
}
const range = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, i) => msg(from + i));

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

/** A fake server holding a channel's messages, answering the REST paging contract. */
function server(all: HubChatMessage[]) {
  const store = { all };
  const messages = vi.fn(
    async (_c: string, o: { before?: number; after?: number; limit?: number }) => {
      const limit = o.limit ?? 50;
      if (o.after !== undefined) {
        const rows = store.all.filter((m) => m.seq > o.after!);
        return { messages: rows.slice(0, limit), hasMore: rows.length > limit } as ChannelPage;
      }
      const rows = store.all.filter((m) => o.before === undefined || m.seq < o.before);
      return { messages: rows.slice(-limit), hasMore: rows.length > limit } as ChannelPage;
    },
  );
  return { store, api: { messages } };
}

const seqs = (ctl: { getState(): { window: { messages: HubChatMessage[] } } }) =>
  ctl.getState().window.messages.map((m) => m.seq);

describe('admitNewMessages', () => {
  it('admits only the message right after the tail', () => {
    expect(admitNewMessages(range(1, 3), [msg(4)])).toMatchObject({
      insert: [msg(4)],
      catchUp: false,
    });
    expect(admitNewMessages(range(1, 3), [msg(6)])).toMatchObject({ insert: [], catchUp: true });
    expect(admitNewMessages(range(1, 3), [msg(2)])).toMatchObject({ updates: [msg(2)] });
  });
});

describe('catchUpStart', () => {
  it('follows the tail, or reloads everything loaded', () => {
    expect(catchUpStart(range(4, 9), false)).toBe(9);
    expect(catchUpStart(range(4, 9), true)).toBe(3);
    expect(catchUpStart([], true)).toBe(0);
  });
});

describe('createChannelSync', () => {
  it('repairs a gap opened by a live message that lands while the first page loads', async () => {
    // The history request answers with 1..50; 51 and 52 were missed, 53
    // arrives over the socket before the history response.
    const { store, api } = server(range(1, 53));
    const first = deferred<ChannelPage>();
    api.messages.mockImplementationOnce(() => first.promise);
    const ctl = createChannelSync('c1', api, () => {});
    const loading = ctl.load();
    ctl.receiveNew([msg(53)]);
    first.resolve({ messages: range(1, 50), hasMore: false });
    await loading;
    expect(seqs(ctl)).toEqual(store.all.map((m) => m.seq));
  });

  it('fetches the missing run when a live message skips ahead', async () => {
    const { store, api } = server(range(1, 5));
    const ctl = createChannelSync('c1', api, () => {});
    await ctl.load();
    store.all = range(1, 8);
    ctl.receiveNew([msg(8)]);
    await vi.waitFor(() => expect(seqs(ctl)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]));
  });

  it('treats the response to an own post like any other new message', async () => {
    const { store, api } = server(range(1, 2));
    const ctl = createChannelSync('c1', api, () => {});
    await ctl.load();
    // Someone else posted 3 before our post became 4.
    store.all = range(1, 4);
    ctl.receiveNew([msg(4)]);
    await vi.waitFor(() => expect(seqs(ctl)).toEqual([1, 2, 3, 4]));
  });

  it('resync replaces messages edited or deleted while away', async () => {
    const { store, api } = server(range(1, 3));
    const ctl = createChannelSync('c1', api, () => {});
    await ctl.load();
    store.all = [
      msg(1),
      msg(2, { body: 'edited', editedAt: '2026-10-13T11:00:00Z' }),
      msg(3, { deletedAt: '2026-10-13T11:00:00Z' }),
    ];
    ctl.resync();
    await vi.waitFor(() =>
      expect(ctl.getState().window.messages.map((m) => [m.body, !!m.deletedAt])).toEqual([
        ['body 1', false],
        ['edited', false],
        ['body 3', true],
      ]),
    );
  });

  it('a resync during the first load reloads after it lands', async () => {
    const { store, api } = server(range(1, 2));
    const first = deferred<ChannelPage>();
    api.messages.mockImplementationOnce(() => first.promise);
    const ctl = createChannelSync('c1', api, () => {});
    const loading = ctl.load();
    ctl.resync();
    store.all = [msg(1, { deletedAt: '2026-10-13T11:00:00Z' }), msg(2)];
    first.resolve({ messages: range(1, 2), hasMore: false });
    await loading;
    expect(ctl.getState().window.messages[0].deletedAt).not.toBeNull();
  });

  it('an edit never inserts a message the window does not hold', async () => {
    const { api } = server(range(1, 2));
    const ctl = createChannelSync('c1', api, () => {});
    await ctl.load();
    ctl.receiveUpdate(msg(9, { body: 'later' }));
    expect(seqs(ctl)).toEqual([1, 2]);
  });

  it('loads older pages before the window', async () => {
    const { api } = server(range(1, 120));
    const ctl = createChannelSync('c1', api, () => {});
    await ctl.load();
    expect(seqs(ctl)[0]).toBe(71);
    expect(ctl.getState().hasMore).toBe(true);
    await ctl.loadOlder();
    expect(seqs(ctl)[0]).toBe(21);
    expect(seqs(ctl)).toHaveLength(100);
  });

  it('stops updating once disposed', async () => {
    const { api } = server(range(1, 2));
    const onChange = vi.fn();
    const ctl = createChannelSync('c1', api, onChange);
    ctl.dispose();
    await ctl.load();
    expect(onChange).not.toHaveBeenCalled();
  });

  it('a full resync over more than one batch of pages refreshes the newest messages too', async () => {
    const total = CHANNEL_PAGE * (MAX_PAGES_PER_BATCH + 3);
    const { store, api } = server(range(1, total));
    const ctl = createChannelSync('c1', api, () => {});
    await ctl.load();
    while (ctl.getState().hasMore) await ctl.loadOlder();
    expect(seqs(ctl)).toHaveLength(total);
    // While away: the oldest and newest loaded messages were edited, and more arrived.
    store.all = [
      msg(1, { body: 'old edited', editedAt: '2026-10-13T11:00:00Z' }),
      ...range(2, total - 1),
      msg(total, { body: 'new edited', editedAt: '2026-10-13T11:00:00Z' }),
      ...range(total + 1, total + 10),
    ];
    const calls = api.messages.mock.calls.length;
    ctl.resync();
    await vi.waitFor(() => expect(seqs(ctl)).toHaveLength(total + 10));
    const shown = ctl.getState().window.messages;
    expect(shown[0].body).toBe('old edited');
    expect(shown[total - 1].body).toBe('new edited');
    expect(api.messages.mock.calls.length - calls).toBeGreaterThan(MAX_PAGES_PER_BATCH);
  });

  it('a forward catch-up longer than one batch reaches the tail', async () => {
    const { store, api } = server(range(1, 10));
    const ctl = createChannelSync('c1', api, () => {});
    await ctl.load();
    const total = 10 + CHANNEL_PAGE * (MAX_PAGES_PER_BATCH + 2);
    store.all = range(1, total);
    ctl.receiveNew([msg(total)]);
    await vi.waitFor(() => expect(seqs(ctl)).toHaveLength(total));
    expect(seqs(ctl)[total - 1]).toBe(total);
  });

  it('a failed page resumes from where it stopped instead of restarting', async () => {
    const { store, api } = server(range(1, 200));
    const ctl = createChannelSync('c1', api, () => {});
    await ctl.load();
    while (ctl.getState().hasMore) await ctl.loadOlder();
    store.all = [...range(1, 199), msg(200, { body: 'edited', editedAt: '2026-10-13T11:00:00Z' })];
    const real = api.messages.getMockImplementation()!;
    let n = 0;
    api.messages.mockImplementation(async (c, o) => {
      n += 1;
      if (n === 3) throw new Error('offline');
      return real(c, o);
    });
    ctl.resync();
    await vi.waitFor(() => expect(n).toBe(3));
    const afterFailure = api.messages.mock.calls.length;
    // The next trigger, even one that does not move the tail, continues the
    // unfinished pass from its cursor.
    ctl.catchUpTo(200);
    await vi.waitFor(() => expect(ctl.getState().window.messages[199].body).toBe('edited'));
    const resumedFrom = api.messages.mock.calls[afterFailure]?.[1]?.after;
    expect(resumedFrom).toBe(100);
  });
});

describe('loadBackTo (jump to a message)', () => {
  it('loads older pages until the window reaches the seq', async () => {
    const { api } = server(range(1, 1000));
    const ctl = createChannelSync('c1', api, () => {});
    await ctl.load();
    expect(seqs(ctl)[0]).toBe(1000 - CHANNEL_PAGE + 1);
    await expect(ctl.loadBackTo(700)).resolves.toBe(true);
    const shown = seqs(ctl);
    expect(shown[0]).toBeLessThanOrEqual(700);
    // Still one contiguous run up to the tail.
    expect(shown).toEqual(range(shown[0], 1000).map((m) => m.seq));
  });

  it('stops after its page allowance and reports the seq is not reached yet', async () => {
    const { api } = server(range(1, 5000));
    const ctl = createChannelSync('c1', api, () => {});
    await ctl.load();
    const before = api.messages.mock.calls.length;
    await expect(ctl.loadBackTo(10, { maxPages: 2 })).resolves.toBe(false);
    expect(api.messages.mock.calls.length - before).toBe(2);
    await expect(ctl.loadBackTo(10, { maxPages: 100 })).resolves.toBe(true);
    expect(seqs(ctl)[0]).toBe(1);
  });

  it('is done at once when the seq is already loaded or no history is left', async () => {
    const { api } = server(range(1, 30));
    const ctl = createChannelSync('c1', api, () => {});
    await ctl.load();
    const before = api.messages.mock.calls.length;
    await expect(ctl.loadBackTo(5)).resolves.toBe(true);
    expect(api.messages.mock.calls.length).toBe(before);
  });

  it('stops requesting pages once cancelled, and drops the page in flight', async () => {
    const { api } = server(range(1, 2000));
    const ctl = createChannelSync('c1', api, () => {});
    await ctl.load();
    const head = seqs(ctl)[0];
    const page = deferred<ChannelPage>();
    api.messages.mockImplementationOnce(() => page.promise);
    let live = true;
    const run = ctl.loadBackTo(10, { live: () => live });
    await vi.waitFor(() => expect(api.messages).toHaveBeenCalledTimes(2));
    live = false;
    page.resolve({ messages: range(head - 100, head - 1), hasMore: true });
    await expect(run).resolves.toBe(false);
    expect(api.messages).toHaveBeenCalledTimes(2);
    expect(seqs(ctl)[0]).toBe(head);
  });
});
