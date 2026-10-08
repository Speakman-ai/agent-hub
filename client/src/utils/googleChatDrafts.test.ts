import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';

const mockList = vi.hoisted(() => vi.fn());
vi.mock('./api', () => ({ api: { listGoogleChatDrafts: mockList } }));

import { SENDING_RECHECK_MS, placeDrafts, useChatDrafts, type ChatDraft } from './googleChatDrafts';

function draft(overrides: Partial<ChatDraft>): ChatDraft {
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
    createdAt: '2026-10-08T10:00:00Z',
    updatedAt: '2026-10-08T10:00:00Z',
    ...overrides,
  };
}

describe('placeDrafts', () => {
  it('anchors a thread draft to the newest loaded message of that thread', () => {
    const messages = [
      { name: 'm1', threadName: 'spaces/AAA/threads/T1' },
      { name: 'm2', threadName: 'spaces/AAA/threads/T2' },
      { name: 'm3', threadName: 'spaces/AAA/threads/T1' },
    ];
    const t1 = draft({ id: 't1', threadName: 'spaces/AAA/threads/T1' });
    const gone = draft({ id: 'gone', threadName: 'spaces/AAA/threads/T9' });
    const plain = draft({ id: 'plain' });
    const { byMessage, unplaced } = placeDrafts(messages, [t1, gone, plain]);
    expect(byMessage.get('m3')).toEqual([t1]);
    expect(byMessage.has('m1')).toBe(false);
    expect(unplaced.map((d) => d.id)).toEqual(['gone', 'plain']);
  });
});

describe('useChatDrafts', () => {
  function deferred<T>() {
    let resolve!: (v: T) => void;
    const promise = new Promise<T>((r) => (resolve = r));
    return { promise, resolve };
  }
  const T = (sec: number) => `2026-10-08T10:00:${String(sec).padStart(2, '0')}.000Z`;
  const emit = (d: ChatDraft) =>
    window.dispatchEvent(new CustomEvent('google_chat_draft_update', { detail: { draft: d } }));

  beforeEach(() => mockList.mockReset());

  it('drops a slow response for a space the user already left', async () => {
    const a = deferred<any>();
    const b = deferred<any>();
    mockList.mockReturnValueOnce(a.promise).mockReturnValueOnce(b.promise);
    const { result, rerender } = renderHook(({ spaceId }) => useChatDrafts({ spaceId }), {
      initialProps: { spaceId: 'AAA' },
    });
    rerender({ spaceId: 'BBB' });
    await act(async () => b.resolve({ drafts: [draft({ id: 'b1', spaceId: 'BBB' })], asOf: T(1) }));
    await act(async () => a.resolve({ drafts: [draft({ id: 'a1', spaceId: 'AAA' })], asOf: T(1) }));
    expect(result.current.drafts.map((d) => d.id)).toEqual(['b1']);
  });

  it('shows nothing from the old space while the new one loads', async () => {
    const b = deferred<any>();
    mockList.mockResolvedValueOnce({ drafts: [draft({ id: 'a1' })], asOf: T(1) });
    mockList.mockReturnValueOnce(b.promise);
    const { result, rerender } = renderHook(({ spaceId }) => useChatDrafts({ spaceId }), {
      initialProps: { spaceId: 'AAA' },
    });
    await waitFor(() => expect(result.current.drafts).toHaveLength(1));
    rerender({ spaceId: 'BBB' });
    expect(result.current.drafts).toEqual([]);
  });

  it('keeps a live update that lands while the list request is in flight', async () => {
    const pending = deferred<any>();
    mockList.mockReturnValueOnce(pending.promise);
    const { result } = renderHook(() => useChatDrafts({ sessionId: 's1' }));
    // The draft is discarded after the server read the (now stale) list.
    act(() => emit(draft({ id: 'x', status: 'discarded', updatedAt: T(3) })));
    act(() => emit(draft({ id: 'y', updatedAt: T(4) })));
    await act(async () =>
      pending.resolve({ drafts: [draft({ id: 'x', updatedAt: T(1) })], asOf: T(2) }),
    );
    expect(result.current.drafts.map((d) => d.id)).toEqual(['y']);
  });
});

describe('useChatDrafts recovery', () => {
  it('re-reads while a draft shows as sending, so an interrupted send becomes actionable', async () => {
    vi.useFakeTimers();
    try {
      const base = {
        id: 'd',
        sessionId: 's1',
        spaceId: 'AAA',
        threadName: null,
        text: 'hi',
        revision: 1,
        error: null,
        sentMessageName: null,
        createdAt: '2026-10-08T10:00:00.000Z',
      };
      mockList.mockReset();
      mockList
        .mockResolvedValueOnce({
          drafts: [{ ...base, status: 'sending', updatedAt: '2026-10-08T10:00:01.000Z' }],
          asOf: '2026-10-08T10:00:02.000Z',
        })
        .mockResolvedValueOnce({
          drafts: [{ ...base, status: 'unconfirmed', updatedAt: '2026-10-08T10:05:00.000Z' }],
          asOf: '2026-10-08T10:05:01.000Z',
        });
      const { result } = renderHook(() => useChatDrafts({ sessionId: 's1' }));
      await act(async () => {});
      expect(result.current.drafts[0].status).toBe('sending');
      await act(async () => {
        vi.advanceTimersByTime(SENDING_RECHECK_MS);
      });
      expect(result.current.drafts[0].status).toBe('unconfirmed');
      expect(mockList).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('useChatDrafts reconnect', () => {
  it('re-reads when the socket reconnects, picking up a draft created during the outage', async () => {
    mockList.mockReset();
    mockList
      .mockResolvedValueOnce({ drafts: [], asOf: '2026-10-08T10:00:01.000Z' })
      .mockResolvedValueOnce({
        drafts: [
          {
            id: 'missed',
            sessionId: 's1',
            spaceId: 'AAA',
            threadName: null,
            text: 'hi',
            revision: 1,
            status: 'pending',
            error: null,
            sentMessageName: null,
            createdAt: '2026-10-08T10:00:05.000Z',
            updatedAt: '2026-10-08T10:00:05.000Z',
          },
        ],
        asOf: '2026-10-08T10:00:06.000Z',
      });
    const { result } = renderHook(() => useChatDrafts({ sessionId: 's1' }));
    await waitFor(() => expect(mockList).toHaveBeenCalledTimes(1));
    expect(result.current.drafts).toEqual([]);
    act(() => {
      window.dispatchEvent(new Event('agenthub:ws_reconnected'));
    });
    await waitFor(() => expect(result.current.drafts.map((d) => d.id)).toEqual(['missed']));
  });
});
