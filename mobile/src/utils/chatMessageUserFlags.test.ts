// @ts-nocheck
import { describe, it, expect } from 'vitest';
import { getUserMessageFlags } from './chatMessageUserFlags';
describe('getUserMessageFlags', () => {
  it('enables in-flight actions for a queued user message during streaming', () => {
    const flags = getUserMessageFlags({ role: 'user', content: 'follow up', queued: true }, true);
    expect(flags.showInFlightActions).toBe(true);
    expect(flags.isUser).toBe(true);
    expect(flags.isQueued).toBe(true);
  });
  it('does not enable in-flight actions for assistant messages', () => {
    const flags = getUserMessageFlags({ role: 'assistant', content: 'hi', queued: true }, true);
    expect(flags.showInFlightActions).toBe(false);
  });
  it('short-circuits safely when not in-flight (regression guard for TDZ-style ordering)', () => {
    // When inFlightWhileStreaming is false, isUser must never be read before defined
    // in ChatMessage — this mirrors the fixed binding order in the component.
    const flags = getUserMessageFlags({ role: 'user', queued: true }, false);
    expect(flags.showInFlightActions).toBe(false);
  });
  it('matches ChatScreen in-flight wiring (queued user message during stream)', () => {
    // ChatScreen passes inFlightWhileStreaming={isQueued && isProcessing}; this is the
    // path that previously threw ReferenceError when isUser was declared too late.
    const flags = getUserMessageFlags(
      {
        id: 'msg-q',
        role: 'user',
        content: 'Queued while assistant streams',
        queued: true,
      },
      true,
    );
    expect(flags.showInFlightActions).toBe(true);
  });
});
