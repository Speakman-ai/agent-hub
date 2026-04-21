import { describe, it, expect, vi } from 'vitest';
import {
  mapRowsFromMessageEventsApi,
  notifyParentOfLoadedEvents,
  applyLazyMessageEventsResult,
} from './sessionTailEventsLoad.js';

/**
 * Contract tests for `SessionTail.js` lazy `getMessageEvents` integration:
 * failures must not call `onEventsLoaded` (see `applyLazyMessageEventsResult`).
 */
describe('sessionTailEventsLoad (mobile SessionTail lazy-fetch)', () => {
  describe('mapRowsFromMessageEventsApi', () => {
    it('parses string JSON in the event column', () => {
      const rows = [{ seq: 1, event: '{"type":"assistant_text","text":"hi","partial":false}' }];
      const out = mapRowsFromMessageEventsApi(rows);
      expect(out[0].seq).toBe(1);
      expect(out[0].event).toEqual({ type: 'assistant_text', text: 'hi', partial: false });
    });

    it('passes through object events', () => {
      const ev = { type: 'ask_user_question', askId: 'a', questions: [] };
      expect(mapRowsFromMessageEventsApi([{ seq: 2, event: ev }])[0].event).toBe(ev);
    });

    it('treats null/undefined as empty', () => {
      expect(mapRowsFromMessageEventsApi(null)).toEqual([]);
      expect(mapRowsFromMessageEventsApi(undefined)).toEqual([]);
    });
  });

  describe('notifyParentOfLoadedEvents', () => {
    it('invokes onEventsLoaded with mapped rows (including empty DB)', () => {
      const on = vi.fn();
      notifyParentOfLoadedEvents(on, 'mid', []);
      expect(on).toHaveBeenCalledTimes(1);
      expect(on).toHaveBeenCalledWith('mid', []);
    });
  });

  describe('applyLazyMessageEventsResult', () => {
    it('does not notify parent when ok is false (HTTP failure path)', () => {
      const on = vi.fn();
      const r = applyLazyMessageEventsResult({
        cancelled: false,
        ok: false,
        data: [],
        messageId: 'm1',
        onEventsLoaded: on,
      });
      expect(r.parentNotified).toBe(false);
      expect(on).not.toHaveBeenCalled();
    });

    it('does not notify parent when cancelled', () => {
      const on = vi.fn();
      const r = applyLazyMessageEventsResult({
        cancelled: true,
        ok: true,
        data: [{ seq: 1, event: { type: 'result' } }],
        messageId: 'm1',
        onEventsLoaded: on,
      });
      expect(r.parentNotified).toBe(false);
      expect(on).not.toHaveBeenCalled();
    });

    it('notifies parent on success with mapped rows', () => {
      const on = vi.fn();
      const r = applyLazyMessageEventsResult({
        cancelled: false,
        ok: true,
        data: [{ seq: 1, event: '{"type":"result","text":"done"}' }],
        messageId: 'm1',
        onEventsLoaded: on,
      });
      expect(r.parentNotified).toBe(true);
      expect(on).toHaveBeenCalledWith('m1', [
        { seq: 1, event: { type: 'result', text: 'done' } },
      ]);
    });
  });
});
