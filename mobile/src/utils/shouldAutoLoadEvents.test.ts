// @ts-nocheck
import { describe, it, expect } from 'vitest';
import { shouldAutoLoadEvents } from './shouldAutoLoadEvents';
describe('shouldAutoLoadEvents', () => {
    it('returns false when messageId is missing', () => {
        expect(shouldAutoLoadEvents({ messageId: null, streaming: false, events: undefined })).toBe(false);
        expect(shouldAutoLoadEvents({ messageId: undefined, streaming: false, events: undefined })).toBe(false);
    });
    it('returns false for streaming messages (ws fills them in)', () => {
        expect(shouldAutoLoadEvents({ messageId: 'm1', streaming: true, events: undefined })).toBe(false);
    });
    it('returns false when events are already loaded (even empty)', () => {
        expect(shouldAutoLoadEvents({ messageId: 'm1', streaming: false, events: [] })).toBe(false);
        expect(shouldAutoLoadEvents({
            messageId: 'm1',
            streaming: false,
            events: [{ seq: 0, event: { type: 'system' } }],
        })).toBe(false);
    });
    it('returns true for a historical message with no events yet', () => {
        expect(shouldAutoLoadEvents({ messageId: 'm1', streaming: false, events: undefined })).toBe(true);
    });
    it('treats omitted streaming as not streaming', () => {
        expect(shouldAutoLoadEvents({ messageId: 'm1', events: undefined })).toBe(true);
    });
});
