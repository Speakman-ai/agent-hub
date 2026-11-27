import { describe, it, expect } from 'vitest';
import { OfferListSync } from './offerListSync';
import type { ProactiveOffer } from './serverAgentProactive';

function offer(id: string, over: Partial<ProactiveOffer> = {}): ProactiveOffer {
  return {
    id,
    kind: 'stale_card',
    area: 'dev',
    title: id,
    reason: '',
    action: '',
    urgency: 'normal',
    status: 'open',
    source: 'scheduled',
    target: {},
    createdAt: '2026-11-27T10:00:00Z',
    updatedAt: '2026-11-27T10:00:00Z',
    expiresAt: null,
    snoozedUntil: null,
    actedAt: null,
    actionSessionId: null,
    revision: 1,
    ...over,
  };
}

const ids = (s: OfferListSync) => s.current().map((o) => o.id);

describe('OfferListSync', () => {
  it('keeps an offer created while an older, empty snapshot was in flight', () => {
    const s = new OfferListSync(() => undefined);
    const token = s.beginFetch();
    s.update({ offer: offer('new') });
    s.snapshot(token, []);
    expect(ids(s)).toEqual(['new']);
  });

  it('does not bring back an offer accepted while the snapshot was in flight', () => {
    const s = new OfferListSync(() => undefined);
    const token = s.beginFetch();
    s.update({ offer: offer('a', { status: 'accepted', revision: 2 }) });
    s.snapshot(token, [offer('a'), offer('b')]);
    expect(ids(s)).toEqual(['b']);
  });

  it('replays a kind removal over the snapshot', () => {
    const s = new OfferListSync(() => undefined);
    const token = s.beginFetch();
    s.removeKind('stale_card');
    s.snapshot(token, [offer('a'), offer('b', { kind: 'finalize_failed' })]);
    expect(ids(s)).toEqual(['b']);
  });

  it('drops a snapshot older than one already applied', () => {
    const s = new OfferListSync(() => undefined);
    const older = s.beginFetch();
    const newer = s.beginFetch();
    s.snapshot(newer, [offer('fresh')]);
    s.snapshot(older, [offer('stale')]);
    expect(ids(s)).toEqual(['fresh']);
  });

  it('applies events directly when no fetch is pending', () => {
    const seen: string[][] = [];
    const s = new OfferListSync((list) => seen.push(list.map((o) => o.id)));
    s.update({ offer: offer('a') });
    s.update({ offerId: 'a', offer: offer('a', { status: 'dismissed', revision: 2 }) });
    expect(seen).toEqual([['a'], []]);
  });

  it('a reopen event beats an older accepted response that lands after it', () => {
    const s = new OfferListSync(() => undefined);
    s.update({ offer: offer('a', { revision: 0 }) });
    // Broadcast: reopened after the dispatch failed (revision 3)…
    s.update({ offer: offer('a', { status: 'open', revision: 3 }) });
    // …then the slow HTTP response for the accept (revision 1).
    s.update({ offer: offer('a', { status: 'accepted', revision: 1 }) });
    expect(ids(s)).toEqual(['a']);
    expect(s.current()[0].revision).toBe(3);
  });

  it('remembers versions of removed offers so a stale open copy cannot revive them', () => {
    const s = new OfferListSync(() => undefined);
    s.update({ offer: offer('a', { status: 'accepted', revision: 2 }) });
    s.update({ offer: offer('a', { status: 'open', revision: 1 }) });
    expect(ids(s)).toEqual([]);
    const token = s.beginFetch();
    s.snapshot(token, [offer('a', { revision: 1 })]);
    expect(ids(s)).toEqual([]);
  });

  it('a snapshot row newer than what was seen replaces it', () => {
    const s = new OfferListSync(() => undefined);
    s.update({ offer: offer('a', { status: 'accepted', revision: 2 }) });
    const token = s.beginFetch();
    s.snapshot(token, [offer('a', { status: 'open', revision: 4 })]);
    expect(ids(s)).toEqual(['a']);
  });
});

describe('OfferListSync with snapshots newer than events received during the fetch', () => {
  it('a reopened snapshot row beats an older accepted event recorded mid-fetch', () => {
    const s = new OfferListSync(() => undefined);
    s.update({ offer: offer('a', { revision: 0 }) });
    const token = s.beginFetch();
    // Accept response / event (rev 1) arrives while the fetch is pending…
    s.update({ offer: offer('a', { status: 'accepted', revision: 1 }) });
    // …the dispatch fails and the server reopens it; the fetch returns rev 3.
    s.snapshot(token, [offer('a', { status: 'open', revision: 3 })]);
    expect(ids(s)).toEqual(['a']);
    // The rev 3 broadcast arriving afterwards changes nothing and keeps it shown.
    s.update({ offer: offer('a', { status: 'open', revision: 3 }) });
    expect(ids(s)).toEqual(['a']);
  });

  it('hides an offer the snapshot no longer lists when nothing newer was seen', () => {
    const s = new OfferListSync(() => undefined);
    s.update({ offer: offer('a') });
    const token = s.beginFetch();
    s.snapshot(token, []);
    expect(ids(s)).toEqual([]);
  });

  it('a later open version can show a kind that was hidden locally', () => {
    const s = new OfferListSync(() => undefined);
    s.update({ offer: offer('a', { revision: 1 }) });
    s.removeKind('stale_card');
    expect(ids(s)).toEqual([]);
    s.update({ offer: offer('a', { revision: 1 }) });
    expect(ids(s)).toEqual([]);
    s.update({ offer: offer('a', { revision: 5 }) });
    expect(ids(s)).toEqual(['a']);
  });
});
