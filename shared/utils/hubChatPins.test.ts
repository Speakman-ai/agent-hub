import { describe, it, expect } from 'vitest';
import type { HubChatMessage, HubChatPinnedMessage } from './hubChat';
import {
  acceptPinsResponse,
  applyPinsMessageUpdate,
  applyPinsMeta,
  beginPinsRequest,
  failPinsRequest,
  initialPinnedList,
} from './hubChatPins';

const PIN = { byUserId: 'bob', at: '2026-10-13T10:00:00.000Z' };

function msg(id: string, over: Partial<HubChatMessage> = {}): HubChatMessage {
  return {
    id,
    channelId: 'c1',
    seq: 1,
    authorKind: 'user',
    authorUserId: 'bob',
    authorAgentId: null,
    body: `${id} v1`,
    refs: [],
    payload: null,
    editedAt: null,
    deletedAt: null,
    createdAt: '2026-10-13T10:00:00.000Z',
    metaRev: 1,
    reactions: [],
    pinned: PIN,
    ...over,
  };
}
const pin = (m: HubChatMessage): HubChatPinnedMessage => ({
  message: m,
  pinnedByUserId: 'bob',
  pinnedAt: PIN.at,
});
const meta = (messageId: string, metaRev: number, pinned: typeof PIN | null, reactions = []) => ({
  messageId,
  channelId: 'c1',
  metaRev,
  reactions,
  pinned,
});
const edit = (id: string, body: string, at = '2026-10-13T11:00:00.000Z') =>
  msg(id, { body, editedAt: at });
const bodies = (s: { pins: HubChatPinnedMessage[] }) => s.pins.map((p) => p.message.body);

/** A loaded list holding `pins`. */
function loaded(pins: HubChatPinnedMessage[]) {
  return acceptPinsResponse(beginPinsRequest(initialPinnedList(), 1), 1, pins);
}

describe('pinned list', () => {
  it('keeps a live edit when a response fetched before it lands afterwards', () => {
    let s = beginPinsRequest(loaded([pin(msg('m1'))]), 2);
    s = applyPinsMessageUpdate(s, edit('m1', 'm1 v2'));
    expect(bodies(s)).toEqual(['m1 v2']);
    s = acceptPinsResponse(s, 2, [pin(msg('m1'))]);
    expect(bodies(s)).toEqual(['m1 v2']);
    // A response that already has a newer edit wins over the remembered one.
    s = acceptPinsResponse(beginPinsRequest(s, 3), 3, [
      pin(edit('m1', 'm1 v3', '2026-10-13T12:00:00.000Z')),
    ]);
    expect(bodies(s)).toEqual(['m1 v3']);
  });

  it('applies edits and deletes that arrive before the first response', () => {
    let s = beginPinsRequest(initialPinnedList(), 1);
    s = applyPinsMessageUpdate(s, edit('m1', 'm1 v2'));
    s = applyPinsMessageUpdate(s, msg('m2', { deletedAt: '2026-10-13T11:00:00.000Z' }));
    s = acceptPinsResponse(s, 1, [pin(msg('m1')), pin(msg('m2'))]);
    expect(bodies(s)).toEqual(['m1 v2']);
  });

  it('drops an unpinned message even from a response fetched before the unpin', () => {
    let s = beginPinsRequest(loaded([pin(msg('m1')), pin(msg('m2'))]), 2);
    s = applyPinsMeta(s, meta('m1', 2, null));
    expect(bodies(s)).toEqual(['m2 v1']);
    expect(s.stale).toBe(false);
    s = acceptPinsResponse(s, 2, [pin(msg('m1')), pin(msg('m2'))]);
    expect(bodies(s)).toEqual(['m2 v1']);
    // Pinned again later: listed again once the reload returns it.
    s = applyPinsMeta(s, meta('m1', 3, PIN));
    expect(s.stale).toBe(true);
    s = acceptPinsResponse(beginPinsRequest(s, 3), 3, [
      pin(msg('m1', { metaRev: 3 })),
      pin(msg('m2')),
    ]);
    expect(s.stale).toBe(false);
    expect(bodies(s)).toEqual(['m1 v1', 'm2 v1']);
  });

  it('marks the list stale for a new pin and applies a request response and its echo once', () => {
    const s0 = loaded([]);
    const s1 = applyPinsMeta(s0, meta('m9', 4, PIN));
    expect(s1.stale).toBe(true);
    const s2 = beginPinsRequest(s1, 2);
    expect(applyPinsMeta(s2, meta('m9', 4, PIN))).toBe(s2);
    expect(applyPinsMeta(s2, meta('m9', 3, null))).toBe(s2);
  });

  it('updates reactions on a listed pin', () => {
    const reactions = [{ emoji: '👍', count: 1, userIds: ['bob'] }] as never;
    const s = applyPinsMeta(loaded([pin(msg('m1'))]), meta('m1', 2, PIN, reactions));
    expect(s.pins[0]!.message.reactions).toEqual(reactions);
    expect(s.stale).toBe(false);
  });

  it('accepts only the latest request', () => {
    let s = beginPinsRequest(initialPinnedList(), 1);
    s = beginPinsRequest(s, 2);
    s = acceptPinsResponse(s, 2, [pin(msg('m1'))]);
    expect(acceptPinsResponse(s, 1, [])).toBe(s);
    expect(failPinsRequest(s, 1, 'boom')).toBe(s);
    expect(failPinsRequest(beginPinsRequest(s, 3), 3, 'boom').error).toBe('boom');
  });

  it('drops a pin unpinned by an edit response that arrives before the unpin event', () => {
    let s = loaded([pin(msg('m1'))]);
    // Another member unpinned at revision 2; the viewer's edit response
    // already carries that state, ahead of the unpin event.
    s = applyPinsMessageUpdate(
      s,
      msg('m1', { body: 'edited', editedAt: '2026-10-13T11:00:00.000Z', metaRev: 2, pinned: null }),
    );
    expect(s.pins).toEqual([]);
    s = applyPinsMeta(s, meta('m1', 2, null));
    expect(s.pins).toEqual([]);
    // A list response fetched before the unpin does not bring it back.
    s = acceptPinsResponse(beginPinsRequest(s, 2), 2, [pin(msg('m1'))]);
    expect(s.pins).toEqual([]);
  });

  it('keeps a pin when an update carries an older unpinned revision', () => {
    let s = loaded([pin(msg('m1', { metaRev: 3 }))]);
    s = applyPinsMessageUpdate(
      s,
      msg('m1', { body: 'edited', editedAt: '2026-10-13T11:00:00.000Z', metaRev: 2, pinned: null }),
    );
    expect(bodies(s)).toEqual(['edited']);
  });

  it('marks the list stale when an update shows a pin it does not hold', () => {
    const s = applyPinsMessageUpdate(loaded([]), msg('m4', { metaRev: 2 }));
    expect(s.stale).toBe(true);
  });

  it('shows a re-pin with its own attribution and position, even before the older unpin', () => {
    const bobPin = { byUserId: 'bob', at: '2026-10-13T10:00:00.000Z' };
    const carolPin = { byUserId: 'carol', at: '2026-10-13T10:30:00.000Z' };
    const alicePin = { byUserId: 'alice', at: '2026-10-13T11:00:00.000Z' };
    const entry = (id: string, p: typeof PIN) => ({
      message: msg(id, { pinned: p }),
      pinnedByUserId: p.byUserId,
      pinnedAt: p.at,
    });
    // Carol's pin is newest, so it is listed first; Bob's m1 is second.
    let s = loaded([entry('m2', carolPin), entry('m1', bobPin)]);
    // Alice re-pins m1 (revision 3) before the unpin (revision 2) arrives.
    s = applyPinsMeta(s, meta('m1', 3, alicePin));
    s = applyPinsMeta(s, meta('m1', 2, null));
    expect(s.stale).toBe(false);
    expect(s.pins.map((p) => [p.message.id, p.pinnedByUserId, p.pinnedAt])).toEqual([
      ['m1', 'alice', alicePin.at],
      ['m2', 'carol', carolPin.at],
    ]);
    // A list response fetched before the re-pin is reconciled the same way.
    s = acceptPinsResponse(beginPinsRequest(s, 2), 2, [entry('m2', carolPin), entry('m1', bobPin)]);
    expect(s.pins.map((p) => [p.message.id, p.pinnedByUserId])).toEqual([
      ['m1', 'alice'],
      ['m2', 'carol'],
    ]);
  });

  it('keeps a live re-pin that a list response read before it leaves out, then settles', () => {
    const repin = { byUserId: 'alice', at: '2026-10-13T12:00:00.000Z' };
    // M is listed; it was unpinned while offline (no event seen).
    let s = loaded([pin(msg('m1'))]);
    // Reconnect fetch: the server reads the list while M is unpinned...
    s = beginPinsRequest(s, 2);
    // ...M is re-pinned and its event arrives before that response.
    s = applyPinsMeta(s, meta('m1', 3, repin));
    s = acceptPinsResponse(s, 2, []);
    expect(s.pins.map((p) => [p.message.id, p.pinnedByUserId])).toEqual([['m1', 'alice']]);
    expect(s.stale).toBe(true);
    // The confirming fetch starts after the re-pin; its list is final.
    s = acceptPinsResponse(beginPinsRequest(s, 3), 3, [
      pin(msg('m1', { metaRev: 3, pinned: repin })),
    ]);
    expect(s.stale).toBe(false);
    expect(s.pins).toHaveLength(1);
  });

  it('drops a pin a response leaves out when nothing newer was seen during the request', () => {
    let s = loaded([pin(msg('m1')), pin(msg('m2'))]);
    // m2 changed live before the request started; that does not shield it.
    s = applyPinsMeta(s, meta('m2', 2, PIN));
    s = acceptPinsResponse(beginPinsRequest(s, 2), 2, [pin(msg('m1'))]);
    expect(s.pins.map((p) => p.message.id)).toEqual(['m1']);
    expect(s.stale).toBe(false);
  });

  it('does not keep a left-out pin whose change during the request was an unpin', () => {
    let s = beginPinsRequest(loaded([pin(msg('m1'))]), 2);
    s = applyPinsMeta(s, meta('m1', 2, null));
    s = acceptPinsResponse(s, 2, []);
    expect(s.pins).toEqual([]);
    expect(s.stale).toBe(false);
  });
});
