import { describe, it, expect } from 'vitest';
import {
  EMPTY_INBOX,
  beginCountRequest,
  deriveInboxRows,
  deriveUnreadCount,
  needsCountRefresh,
  pendingWriteCount,
  withCountResponse,
  countRequestOverlapsWrite,
  withFirstPage,
  withLiveRow,
  withNextPage,
  withServerRead,
  withServerReadAll,
  withWrite,
  withWriteDone,
  withWriteFailed,
  newestCreatedAt,
  type InboxFacts,
  type InboxNotification,
} from './notificationInbox';

function n(id: string, createdAt: string, readAt: string | null = null): InboxNotification {
  return {
    id,
    userId: 'u',
    orgId: null,
    projectId: null,
    category: 'dm',
    title: id,
    body: '',
    route: null,
    data: null,
    sourceKey: id,
    createdAt,
    readAt,
  };
}

const a = n('a', '2026-10-15T10:00:00.000Z');
const b = n('b', '2026-10-15T11:00:00.000Z');
const c = n('c', '2026-10-15T12:00:00.000Z');
const ALL_TOKEN = 'tall';
const readAll = { token: ALL_TOKEN, kind: 'read_all' as const, cutoff: '2026-10-15T11:30:00.000Z' };

const readA = { token: 'ta', kind: 'read' as const, id: 'a', createdAt: a.createdAt };
const readB = { token: 'tb', kind: 'read' as const, id: 'b', createdAt: b.createdAt };
const readC = { token: 'tc', kind: 'read' as const, id: 'c', createdAt: c.createdAt };

const count = (f: InboxFacts) => deriveUnreadCount(f, deriveInboxRows(f));
const withServerCount = (f: InboxFacts, n: number) =>
  withCountResponse(f, beginCountRequest(f), n)!;

describe('notification inbox rows', () => {
  it('merges live rows with pages newest first, without duplicates', () => {
    let f = withFirstPage(EMPTY_INBOX, [b, a]);
    f = withLiveRow(f, c);
    f = withLiveRow(f, c);
    expect(deriveInboxRows(f).map((x) => x.id)).toEqual(['c', 'b', 'a']);
  });

  it('a live row survives an older first-page snapshot', () => {
    const f = withFirstPage(withLiveRow(EMPTY_INBOX, c), [b, a]);
    expect(deriveInboxRows(f).map((x) => x.id)).toEqual(['c', 'b', 'a']);
  });

  it('a server read survives an older page that still says unread, in either order', () => {
    const before = withFirstPage(withServerRead(EMPTY_INBOX, ['a'], 'r1'), [b, a]);
    const after = withServerRead(withFirstPage(EMPTY_INBOX, [b, a]), ['a'], 'r1');
    for (const f of [before, after]) {
      expect(deriveInboxRows(f).find((x) => x.id === 'a')?.readAt).toBe('r1');
    }
  });

  it('server mark-all spares rows created after it', () => {
    const f = withServerReadAll(withFirstPage(EMPTY_INBOX, [c, a]), '2026-10-15T11:00:00.000Z');
    expect(deriveInboxRows(f).map((x) => !!x.readAt)).toEqual([false, true]);
  });

  it('a pending write overlays pages fetched after it started', () => {
    let f = withWrite(EMPTY_INBOX, readAll);
    f = withNextPage(withFirstPage(f, [c]), [b, a]);
    expect(deriveInboxRows(f).map((x) => !!x.readAt)).toEqual([false, true, true]);
  });

  it('a failed write un-reads only what it marked', () => {
    let f = withFirstPage(EMPTY_INBOX, [b, a]);
    f = withWrite(f, readAll);
    f = withServerRead(f, ['a'], 'server');
    f = withWriteFailed(f, ALL_TOKEN);
    expect(deriveInboxRows(f).map((x) => [x.id, x.readAt])).toEqual([
      ['b', null],
      ['a', 'server'],
    ]);
  });

  it('a successful write keeps overlaying rows from pages that resolve later', () => {
    let f = withWriteDone(withWrite(EMPTY_INBOX, readA), 'ta');
    f = withFirstPage(f, [b, a]);
    expect(deriveInboxRows(f).map((x) => [x.id, x.readAt])).toEqual([
      ['b', null],
      ['a', 'ta'],
    ]);
  });
});

describe('notification inbox count', () => {
  it('subtracts writes the server count does not reflect yet', () => {
    let f = withServerCount(withFirstPage(EMPTY_INBOX, [b, a]), 2);
    f = withWrite(f, readA);
    expect(count(f)).toBe(1);
    f = withWriteDone(f, 'ta');
    expect(count(f)).toBe(1);
    expect(needsCountRefresh(f)).toBe(true);
  });

  it('settles to the GET issued after writes finish, whatever order they answered in', () => {
    let f = withServerCount(withFirstPage(EMPTY_INBOX, [b, a]), 2);
    f = withWrite(withWrite(f, readA), readB);
    // B answers before A; neither response count is used.
    f = withWriteDone(f, 'tb');
    expect(pendingWriteCount(f)).toBe(1);
    expect(count(f)).toBe(0);
    f = withWriteDone(f, 'ta');
    expect(count(f)).toBe(0);
    const req = beginCountRequest(f);
    f = withCountResponse(f, req, 0)!;
    expect(count(f)).toBe(0);
    expect(needsCountRefresh(f)).toBe(false);
  });

  it('rejects a count GET when a newer count landed while it was in flight', () => {
    let f = withServerCount(EMPTY_INBOX, 3);
    const req = beginCountRequest(f);
    f = withLiveRow(f, c, 4);
    expect(withCountResponse(f, req, 3)).toBeNull();
    expect(count(f)).toBe(4);
  });

  it('a settled write stays subtracted until a GET issued after it lands', () => {
    let f = withServerCount(EMPTY_INBOX, 2);
    f = withWriteDone(withWrite(f, readA), 'ta');
    expect(count(f)).toBe(1);
    expect(needsCountRefresh(f)).toBe(true);
    f = withCountResponse(f, beginCountRequest(f), 1)!;
    expect(count(f)).toBe(1);
    expect(needsCountRefresh(f)).toBe(false);
  });

  it('the server read event for a row reflects that write', () => {
    let f = withServerCount(EMPTY_INBOX, 2);
    f = withWrite(f, readA);
    f = withServerRead(f, ['a'], 'server', 1);
    expect(count(f)).toBe(1);
    f = withWriteDone(f, 'ta');
    expect(needsCountRefresh(f)).toBe(false);
  });

  it('an older server mark-all only reflects writes on rows it covers', () => {
    let f = withServerCount(withFirstPage(EMPTY_INBOX, [c, a]), 2);
    f = withWrite(f, readC);
    // A mark-all from another tab, cut off before c was created, arrives late.
    f = withServerReadAll(f, '2026-10-15T11:00:00.000Z', 1);
    expect(f.writes[0].reflected).toBe(false);
    expect(count(f)).toBe(0);
    f = withWriteDone(f, 'tc');
    expect(deriveInboxRows(f).find((x) => x.id === 'c')?.readAt).toBe('tc');
    expect(needsCountRefresh(f)).toBe(true);
  });

  it('a pending mark-all leaves only loaded rows newer than it', () => {
    const f = withWrite(withServerCount(withFirstPage(EMPTY_INBOX, [c, b, a]), 9), readAll);
    expect(count(f)).toBe(1);
  });
});

describe('mark-all cutoffs use server time only', () => {
  it('a successful mark-all takes the server readAt, so later rows stay unread', () => {
    let f = withFirstPage(EMPTY_INBOX, [b, a]);
    f = withWrite(f, { token: 'local-1', kind: 'read_all', cutoff: newestCreatedAt([b, a]) });
    f = withWriteDone(f, 'local-1', '2026-10-15T11:05:00.000Z');
    // Created on the server after the mark-all, whatever the browser clock says.
    f = withLiveRow(f, n('later', '2026-10-15T11:06:00.000Z'));
    expect(deriveInboxRows(f).map((x) => [x.id, !!x.readAt])).toEqual([
      ['later', false],
      ['b', true],
      ['a', true],
    ]);
  });

  it('without a server readAt the pending cutoff (newest loaded row) is kept', () => {
    let f = withFirstPage(EMPTY_INBOX, [b, a]);
    f = withWrite(f, { token: 'local-1', kind: 'read_all', cutoff: newestCreatedAt([b, a]) });
    f = withWriteDone(f, 'local-1');
    f = withLiveRow(f, n('later', '2026-10-15T11:00:00.001Z'));
    expect(deriveInboxRows(f).map((x) => !!x.readAt)).toEqual([false, true, true]);
  });

  it('a mark-all with nothing loaded covers no rows', () => {
    let f = withWrite(EMPTY_INBOX, { token: 'local-1', kind: 'read_all', cutoff: null });
    f = withFirstPage(f, [a]);
    expect(deriveInboxRows(f)[0].readAt).toBeNull();
  });
});

describe('count GETs that overlap a write', () => {
  it('rejects a GET when a write started while it was in flight', () => {
    let f = withServerCount(withFirstPage(EMPTY_INBOX, [b, a]), 2);
    const req = beginCountRequest(f);
    f = withWrite(f, readA);
    // The server applied A before reading the count, so the GET says 1.
    expect(countRequestOverlapsWrite(f, req)).toBe(true);
    expect(withCountResponse(f, req, 1)).toBeNull();
    expect(count(f)).toBe(1);
  });

  it('also rejects when the overlapping write already settled', () => {
    let f = withServerCount(EMPTY_INBOX, 2);
    const req = beginCountRequest(f);
    f = withWriteDone(withWrite(f, readA), 'ta');
    expect(withCountResponse(f, req, 1)).toBeNull();
    const fresh = withCountResponse(f, beginCountRequest(f), 1)!;
    expect(count(fresh)).toBe(1);
  });
});

describe('row copies from different sources', () => {
  it('a read copy from Load more wins over a stale live copy', () => {
    // Arrived live, then read elsewhere while the socket was down.
    let f = withLiveRow(EMPTY_INBOX, n('x', '2026-10-15T09:00:00.000Z'));
    f = withFirstPage(f, [c, b]);
    f = withNextPage(f, [n('x', '2026-10-15T09:00:00.000Z', 'elsewhere'), a]);
    expect(f.liveRows).toEqual([]);
    expect(deriveInboxRows(f).find((r) => r.id === 'x')?.readAt).toBe('elsewhere');
  });

  it('a read copy is not undone by a later unread copy of the same row', () => {
    let f = withNextPage(withFirstPage(EMPTY_INBOX, [c]), [n('b', b.createdAt, 'r1')]);
    f = withFirstPage(f, [c, b]);
    f = withLiveRow(f, b);
    expect(deriveInboxRows(f).find((r) => r.id === 'b')?.readAt).toBe('r1');
  });

  it('an overlapping next page that reports a row read updates it', () => {
    let f = withFirstPage(EMPTY_INBOX, [c, b]);
    f = withNextPage(f, [n('b', b.createdAt, 'r2'), a]);
    expect(deriveInboxRows(f).map((r) => [r.id, r.readAt])).toEqual([
      ['c', null],
      ['b', 'r2'],
      ['a', null],
    ]);
  });
});
