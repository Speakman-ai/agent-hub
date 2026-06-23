import { describe, it, expect } from 'vitest';
import { isBenignUnknownStreamEvent, shouldSuppressStreamEvent } from './benignStreamEvents.js';

describe('benignStreamEvents', () => {
  it('matches Claude control-plane frames', () => {
    expect(
      isBenignUnknownStreamEvent({
        type: 'unknown',
        text: 'unhandled claude event: control_request',
      }),
    ).toBe(true);
    expect(
      isBenignUnknownStreamEvent({
        type: 'unknown',
        text: 'unhandled claude event: sdk_control_response',
      }),
    ).toBe(true);
  });

  it('does not match real parser gaps', () => {
    expect(
      isBenignUnknownStreamEvent({
        type: 'unknown',
        text: 'unhandled claude event: tool_progress',
      }),
    ).toBe(false);
    expect(
      isBenignUnknownStreamEvent({
        type: 'unknown',
        text: 'unhandled cursor event: status',
      }),
    ).toBe(false);
  });

  it('shouldSuppressStreamEvent only filters benign unknown rows', () => {
    expect(shouldSuppressStreamEvent({ type: 'assistant_text', text: 'hi' })).toBe(false);
    expect(
      shouldSuppressStreamEvent({
        type: 'unknown',
        text: 'unhandled claude event: control_request',
      }),
    ).toBe(true);
  });
});
