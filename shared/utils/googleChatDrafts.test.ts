import { describe, it, expect } from 'vitest';
import {
  EMPTY_DRAFT_STATE,
  applyDraftUpdate,
  reconcileDraftSnapshot,
  type ChatDraft,
  type DraftListState,
} from './googleChatDrafts';

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
    createdAt: '2026-10-08T10:00:00.000Z',
    updatedAt: '2026-10-08T10:00:00.000Z',
    ...overrides,
  };
}

const ids = (s: DraftListState) => s.drafts.map((d) => d.id);
const T = (sec: number) => `2026-10-08T10:00:${String(sec).padStart(2, '0')}.000Z`;

describe('applyDraftUpdate', () => {
  it('appends open drafts that match the filter and ignores others', () => {
    expect(
      ids(applyDraftUpdate(EMPTY_DRAFT_STATE, draft({ id: 'a' }), { sessionId: 's1' })),
    ).toEqual(['a']);
    expect(
      ids(
        applyDraftUpdate(EMPTY_DRAFT_STATE, draft({ id: 'b', sessionId: 's2' }), {
          sessionId: 's1',
        }),
      ),
    ).toEqual([]);
    expect(
      ids(applyDraftUpdate(EMPTY_DRAFT_STATE, draft({ id: 'a' }), { spaceId: 'BBB' })),
    ).toEqual([]);
  });

  it('keeps unconfirmed drafts open and drops sent or discarded ones for good', () => {
    let s = applyDraftUpdate(EMPTY_DRAFT_STATE, draft({ id: 'a' }), {});
    s = applyDraftUpdate(s, draft({ id: 'a', status: 'unconfirmed', updatedAt: T(1) }), {});
    expect(s.drafts[0].status).toBe('unconfirmed');
    s = applyDraftUpdate(s, draft({ id: 'a', status: 'sent', updatedAt: T(2) }), {});
    expect(ids(s)).toEqual([]);
    // A late event from before the send must not bring it back.
    s = applyDraftUpdate(s, draft({ id: 'a', status: 'sending', updatedAt: T(1) }), {});
    expect(ids(s)).toEqual([]);
  });

  it('ignores an update older than the copy it already holds', () => {
    let s = applyDraftUpdate(
      EMPTY_DRAFT_STATE,
      draft({ id: 'a', text: 'new', updatedAt: T(5) }),
      {},
    );
    s = applyDraftUpdate(s, draft({ id: 'a', text: 'old', updatedAt: T(3) }), {});
    expect(s.drafts[0].text).toBe('new');
  });
});

describe('reconcileDraftSnapshot', () => {
  it('replays updates that arrived while the list request was in flight', () => {
    const snapshot = [draft({ id: 'a', updatedAt: T(1) }), draft({ id: 'b', updatedAt: T(1) })];
    const inFlight = [
      draft({ id: 'a', status: 'discarded', updatedAt: T(3) }),
      draft({ id: 'c', updatedAt: T(4) }),
    ];
    const s = reconcileDraftSnapshot(EMPTY_DRAFT_STATE, snapshot, T(2), inFlight, {});
    expect(ids(s)).toEqual(['b', 'c']);
  });

  it('skips in-flight updates the snapshot already reflects', () => {
    // `x` was pending, then discarded before the snapshot was read; the stale
    // pending event must not resurrect it.
    const inFlight = [draft({ id: 'x', updatedAt: T(1) })];
    const s = reconcileDraftSnapshot(EMPTY_DRAFT_STATE, [], T(2), inFlight, {});
    expect(ids(s)).toEqual([]);
  });
});
