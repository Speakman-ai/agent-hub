import { describe, it, expect } from 'vitest';
import { shouldPersistStreamEvent } from './benign-stream-events.js';
import type { StreamEvent } from './types.js';

describe('shouldPersistStreamEvent', () => {
  it('drops benign unknown control-plane frames', () => {
    expect(
      shouldPersistStreamEvent({
        type: 'unknown',
        text: 'unhandled claude event: control_request',
      } as StreamEvent),
    ).toBe(false);
  });

  it('drops tool_progress keep-alives', () => {
    expect(
      shouldPersistStreamEvent({
        type: 'unknown',
        text: 'unhandled claude event: tool_progress',
      } as StreamEvent),
    ).toBe(false);
  });

  it('drops persisted Grok plan-snapshot unknowns', () => {
    expect(
      shouldPersistStreamEvent({
        type: 'unknown',
        text: 'unhandled grok event: {"type":"plan","entries":[{"content":"Explore","status":"in_progress"}]}',
      } as StreamEvent),
    ).toBe(false);
  });

  it('keeps unrecognized unknown frames for debugging', () => {
    expect(
      shouldPersistStreamEvent({
        type: 'unknown',
        text: 'unhandled claude event: some_future_frame',
      } as StreamEvent),
    ).toBe(true);
  });

  it('always persists normal stream events', () => {
    expect(
      shouldPersistStreamEvent({
        type: 'assistant_text',
        text: 'hi',
        partial: false,
      } as StreamEvent),
    ).toBe(true);
  });
});
