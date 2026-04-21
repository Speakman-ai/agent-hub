import { describe, it, expect } from 'vitest';
import { deriveAssistantTailOutcome } from './assistantTailOutcome.js';

describe('deriveAssistantTailOutcome', () => {
  it('returns working while streaming', () => {
    expect(
      deriveAssistantTailOutcome({
        streaming: true,
        events: [{ seq: 0, event: { type: 'result', isError: false } }],
        messageContent: '',
      }),
    ).toEqual({ phase: 'working' });
  });

  it('uses the last result event for success', () => {
    const events = [
      { seq: 0, event: { type: 'assistant_text', text: 'hi', partial: false } },
      { seq: 1, event: { type: 'result', isError: false, text: 'ok' } },
    ];
    expect(deriveAssistantTailOutcome({ streaming: false, events, messageContent: '' })).toEqual({
      phase: 'done',
    });
  });

  it('uses the last result event for failure', () => {
    const events = [{ seq: 0, event: { type: 'result', isError: true, text: 'CLI blew up' } }];
    expect(deriveAssistantTailOutcome({ streaming: false, events, messageContent: '' })).toEqual({
      phase: 'error',
      detail: 'CLI blew up',
    });
  });

  it('falls back to a generic error line when result isError without text', () => {
    const events = [{ seq: 0, event: { type: 'result', isError: true } }];
    expect(
      deriveAssistantTailOutcome({ streaming: false, events, messageContent: '' }).detail,
    ).toBe('The agent run reported an error.');
  });

  it('prefers a later explicit error event over an earlier success result', () => {
    const events = [
      { seq: 0, event: { type: 'result', isError: false, text: 'ok' } },
      { seq: 1, event: { type: 'error', message: 'post-run failure' } },
    ];
    expect(deriveAssistantTailOutcome({ streaming: false, events, messageContent: '' })).toEqual({
      phase: 'error',
      detail: 'post-run failure',
    });
  });

  it('detects persisted assistant error rows (legacy bubble)', () => {
    expect(
      deriveAssistantTailOutcome({
        streaming: false,
        events: [],
        messageContent: 'Error: cursor-agent exited with code 1',
      }),
    ).toEqual({ phase: 'error', detail: 'cursor-agent exited with code 1' });
  });

  it('defaults to done for empty events and non-error content', () => {
    expect(
      deriveAssistantTailOutcome({
        streaming: false,
        events: [],
        messageContent: 'All good.',
      }),
    ).toEqual({ phase: 'done' });
  });
});
