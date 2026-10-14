import { describe, it, expect, vi } from 'vitest';
import { createPinsLoader } from './hubChatPins';
import type { HubChatMessage, HubChatPinnedMessage } from '@shared/utils/hubChat';

const PIN = { byUserId: 'bob', at: '2026-10-13T10:00:00.000Z' };

function message(id: string, over: Partial<HubChatMessage> = {}): HubChatMessage {
  return {
    id,
    channelId: 'c1',
    seq: 1,
    authorKind: 'user',
    authorUserId: 'bob',
    authorAgentId: null,
    body: id,
    refs: [],
    payload: null,
    editedAt: null,
    deletedAt: null,
    createdAt: '2026-10-13T10:00:00.000Z',
    metaRev: 1,
    pinned: PIN,
    ...over,
  };
}
const pin = (id: string, over: Partial<HubChatMessage> = {}): HubChatPinnedMessage => ({
  message: message(id, over),
  pinnedByUserId: 'bob',
  pinnedAt: PIN.at,
});
const meta = (messageId: string, metaRev: number, pinned: typeof PIN | null, channelId = 'c1') => ({
  messageId,
  channelId,
  metaRev,
  reactions: [],
  pinned,
});

function deferred<T>() {
  let resolve: (v: T) => void = () => {};
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}
const flush = () => new Promise((r) => setTimeout(r, 0));

describe('createPinsLoader', () => {
  it('reloads for a new pin, ignoring other channels and repeats of a change', async () => {
    const pins = vi.fn().mockResolvedValue({ pins: [pin('m1')] });
    const loader = createPinsLoader('c1', { pins }, () => {});
    await loader.reload();
    loader.receiveMeta(meta('m2', 1, PIN, 'c2'));
    expect(pins).toHaveBeenCalledTimes(1);
    pins.mockResolvedValue({ pins: [pin('m2'), pin('m1')] });
    loader.receiveMeta(meta('m2', 1, PIN));
    // The live echo of the same change (or the request's response) applies once.
    loader.receiveMeta(meta('m2', 1, PIN));
    await flush();
    expect(pins).toHaveBeenCalledTimes(2);
    expect(loader.getState().pins.map((p) => p.message.id)).toEqual(['m2', 'm1']);
  });

  it('removes an unpinned message at once, without a reload', async () => {
    const pins = vi.fn().mockResolvedValue({ pins: [pin('m1')] });
    const loader = createPinsLoader('c1', { pins }, () => {});
    await loader.reload();
    loader.receiveMeta(meta('m1', 2, null));
    expect(loader.getState().pins).toEqual([]);
    expect(pins).toHaveBeenCalledTimes(1);
  });

  it('keeps a live edit when an older response lands after it', async () => {
    const late = deferred<{ pins: HubChatPinnedMessage[] }>();
    const pins = vi
      .fn()
      .mockReturnValueOnce(late.promise)
      .mockResolvedValue({ pins: [pin('m1')] });
    const loader = createPinsLoader('c1', { pins }, () => {});
    const pending = loader.reload();
    // The edit arrives while the first list request is still out. It shows
    // a pin the list does not hold yet, so the list is fetched again too.
    loader.receiveUpdate(message('m1', { body: 'edited', editedAt: '2026-10-13T11:00:00.000Z' }));
    late.resolve({ pins: [pin('m1')] });
    await pending;
    await flush();
    expect(pins).toHaveBeenCalledTimes(2);
    expect(loader.getState().pins[0]!.message.body).toBe('edited');
  });

  it('drops an older response that lands after a newer one', async () => {
    const first = deferred<{ pins: HubChatPinnedMessage[] }>();
    const pins = vi
      .fn()
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce({ pins: [pin('m1')] });
    const loader = createPinsLoader('c1', { pins }, () => {});
    const a = loader.reload();
    await loader.reload();
    first.resolve({ pins: [] });
    await a;
    expect(loader.getState().pins.map((p) => p.message.id)).toEqual(['m1']);
  });

  it('applies a delete of a listed message', async () => {
    const pins = vi.fn().mockResolvedValue({ pins: [pin('m1')] });
    const loader = createPinsLoader('c1', { pins }, () => {});
    await loader.reload();
    loader.receiveUpdate(message('m1', { deletedAt: '2026-10-13T12:00:00.000Z' }));
    expect(loader.getState().pins).toEqual([]);
  });

  it('keeps a re-pin that a reconnect response left out and refetches to confirm', async () => {
    const repin = { byUserId: 'alice', at: '2026-10-13T12:00:00.000Z' };
    const stale = deferred<{ pins: HubChatPinnedMessage[] }>();
    const pins = vi
      .fn()
      .mockResolvedValueOnce({ pins: [pin('m1')] })
      .mockReturnValueOnce(stale.promise)
      .mockResolvedValue({ pins: [pin('m1', { metaRev: 3, pinned: repin })] });
    const loader = createPinsLoader('c1', { pins }, () => {});
    await loader.reload();
    // Reconnect: the list is read while m1 is unpinned; the re-pin event lands first.
    const reconnect = loader.reload();
    loader.receiveMeta(meta('m1', 3, repin));
    stale.resolve({ pins: [] });
    await reconnect;
    expect(loader.getState().pins.map((p) => p.pinnedByUserId)).toEqual(['alice']);
    await flush();
    expect(pins).toHaveBeenCalledTimes(3);
    expect(loader.getState().pins.map((p) => p.pinnedByUserId)).toEqual(['alice']);
    expect(loader.getState().stale).toBe(false);
  });
});
