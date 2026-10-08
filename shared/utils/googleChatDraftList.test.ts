import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  DraftListController,
  IDLE_REFRESH_MS,
  RETRY_BASE_MS,
  SENDING_RECHECK_MS,
  type DraftListPage,
} from './googleChatDraftList';
import type { ChatDraft } from './googleChatDrafts';

const T = (sec: number) => `2026-10-08T10:00:${String(sec).padStart(2, '0')}.000Z`;
function draft(over: Partial<ChatDraft>): ChatDraft {
  return {
    id: 'd',
    sessionId: 's1',
    spaceId: 'AAA',
    threadName: null,
    text: 'hi',
    revision: 1,
    status: 'pending',
    error: null,
    sentMessageName: null,
    createdAt: T(0),
    updatedAt: T(0),
    ...over,
  };
}
function deferred<V>() {
  let resolve!: (v: V) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<V>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
const ids = (c: DraftListController) => c.getSnapshot().drafts.map((d) => d.id);
const flush = () => vi.advanceTimersByTimeAsync(0);

describe('DraftListController', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('drops a slow response that a newer load superseded', async () => {
    const first = deferred<DraftListPage>();
    const second = deferred<DraftListPage>();
    const fetch = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const c = new DraftListController({ sessionId: 's1' }, { fetch });
    c.reload();
    c.reload();
    second.resolve({ drafts: [draft({ id: 'new' })], asOf: T(2) });
    await flush();
    first.resolve({ drafts: [draft({ id: 'old' })], asOf: T(1) });
    await flush();
    expect(ids(c)).toEqual(['new']);
  });

  it('replays live updates that land while a load is in flight', async () => {
    const load = deferred<DraftListPage>();
    const c = new DraftListController({ sessionId: 's1' }, { fetch: () => load.promise });
    c.reload();
    c.apply(draft({ id: 'x', status: 'discarded', updatedAt: T(3) }));
    c.apply(draft({ id: 'y', updatedAt: T(4) }));
    load.resolve({ drafts: [draft({ id: 'x', updatedAt: T(1) })], asOf: T(2) });
    await flush();
    expect(ids(c)).toEqual(['y']);
  });

  it('ignores everything after dispose: loads, live updates, and action results', async () => {
    const load = deferred<DraftListPage>();
    const fetch = vi.fn().mockReturnValue(load.promise);
    const c = new DraftListController({ sessionId: 's1' }, { fetch });
    const listener = vi.fn();
    c.subscribe(listener);
    c.reload();
    c.dispose();
    load.resolve({ drafts: [draft({ id: 'a' })] });
    await flush();
    c.apply(draft({ id: 'late' }));
    c.reload();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(ids(c)).toEqual([]);
    expect(listener).not.toHaveBeenCalled();
  });

  it('keeps the last good list on a failed load and retries with backoff until it recovers', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce({ drafts: [draft({ id: 'a' })], asOf: T(1) })
      .mockRejectedValueOnce(new Error('offline'))
      .mockRejectedValueOnce(new Error('still offline'))
      .mockResolvedValueOnce({ drafts: [draft({ id: 'a' }), draft({ id: 'b' })], asOf: T(5) });
    const c = new DraftListController({ sessionId: 's1' }, { fetch });
    c.reload();
    await flush();
    c.reload();
    await flush();
    expect(c.getSnapshot()).toMatchObject({ error: 'offline' });
    expect(ids(c)).toEqual(['a']);

    await vi.advanceTimersByTimeAsync(RETRY_BASE_MS);
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(c.getSnapshot().error).toBe('still offline');
    expect(ids(c)).toEqual(['a']);

    // Backoff doubles.
    await vi.advanceTimersByTimeAsync(RETRY_BASE_MS);
    expect(fetch).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(RETRY_BASE_MS);
    expect(fetch).toHaveBeenCalledTimes(4);
    expect(c.getSnapshot().error).toBeNull();
    expect(ids(c)).toEqual(['a', 'b']);

    // Recovered and nothing is sending: back to the idle refresh, no retry storm.
    await vi.advanceTimersByTimeAsync(IDLE_REFRESH_MS - 1);
    expect(fetch).toHaveBeenCalledTimes(4);
  });

  it('an explicit reload recovers a failed first load right away', async () => {
    const fetch = vi
      .fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce({ drafts: [draft({ id: 'a' })] });
    const c = new DraftListController({ sessionId: 's1' }, { fetch });
    c.reload();
    await flush();
    expect(c.getSnapshot().error).toBe('offline');
    c.reload();
    await flush();
    expect(c.getSnapshot()).toMatchObject({ error: null });
    expect(ids(c)).toEqual(['a']);
    // The pending backoff retry was cancelled by the explicit reload.
    await vi.advanceTimersByTimeAsync(RETRY_BASE_MS);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('re-reads while a draft shows as sending', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce({
        drafts: [draft({ status: 'sending', updatedAt: T(1) })],
        asOf: T(2),
      })
      .mockResolvedValueOnce({
        drafts: [draft({ status: 'unconfirmed', updatedAt: T(9) })],
        asOf: T(10),
      });
    const c = new DraftListController({ sessionId: 's1' }, { fetch });
    c.reload();
    await flush();
    expect(c.getSnapshot().drafts[0].status).toBe('sending');
    await vi.advanceTimersByTimeAsync(SENDING_RECHECK_MS);
    expect(c.getSnapshot().drafts[0].status).toBe('unconfirmed');
    await vi.advanceTimersByTimeAsync(SENDING_RECHECK_MS * 3);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('picks up a draft created while the socket was down on the idle refresh', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce({ drafts: [], asOf: T(1) })
      // Created during the outage: no live update ever reached this view.
      .mockResolvedValueOnce({ drafts: [draft({ id: 'missed', updatedAt: T(30) })], asOf: T(59) });
    const c = new DraftListController({ sessionId: 's1' }, { fetch });
    c.reload();
    await flush();
    expect(ids(c)).toEqual([]);
    await vi.advanceTimersByTimeAsync(IDLE_REFRESH_MS);
    expect(ids(c)).toEqual(['missed']);
  });

  it('also refreshes stale pending cards: an edit or discard missed during an outage', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce({ drafts: [draft({ id: 'a' }), draft({ id: 'b' })], asOf: T(1) })
      .mockResolvedValueOnce({
        drafts: [draft({ id: 'a', text: 'edited elsewhere', revision: 2, updatedAt: T(20) })],
        asOf: T(30),
      });
    const c = new DraftListController({ sessionId: 's1' }, { fetch });
    c.reload();
    await flush();
    await vi.advanceTimersByTimeAsync(IDLE_REFRESH_MS);
    expect(c.getSnapshot().drafts).toEqual([
      expect.objectContaining({ id: 'a', text: 'edited elsewhere', revision: 2 }),
    ]);
  });

  it('a draft turning to sending shortens a pending idle wait', async () => {
    const fetch = vi.fn().mockResolvedValue({ drafts: [draft({ id: 'a' })], asOf: T(1) });
    const c = new DraftListController({ sessionId: 's1' }, { fetch });
    c.reload();
    await flush();
    c.apply(draft({ id: 'a', status: 'sending', updatedAt: T(2) }));
    await vi.advanceTimersByTimeAsync(SENDING_RECHECK_MS);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
