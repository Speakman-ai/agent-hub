import { describe, expect, it } from 'vitest';
import {
  parseSessionForwardDispatchKey,
  sessionForwardDispatchKey,
  sessionForwardDispatchKeyPrefix,
} from './sessionForwardDispatchKey';

describe('sessionForwardDispatchKey', () => {
  it('is the same for every tab showing the card', () => {
    const args = { sessionId: 'chat-1', messageId: 'm-1', forwardId: 'fwd', occurrence: 0 };
    expect(sessionForwardDispatchKey(args)).toBe('session-forward:chat-1:m-1:fwd:0');
    expect(sessionForwardDispatchKey({ ...args })).toBe(sessionForwardDispatchKey(args));
  });

  it('differs per message and per occurrence', () => {
    const base = { sessionId: 'chat-1', messageId: 7, forwardId: 'fwd', occurrence: 0 };
    expect(sessionForwardDispatchKey(base)).not.toBe(
      sessionForwardDispatchKey({ ...base, messageId: 8 }),
    );
    expect(sessionForwardDispatchKey(base)).not.toBe(
      sessionForwardDispatchKey({ ...base, occurrence: 1 }),
    );
  });

  it('is null for a card with no saved message', () => {
    expect(
      sessionForwardDispatchKey({ sessionId: 'c', messageId: null, forwardId: 'f', occurrence: 0 }),
    ).toBeNull();
    expect(
      sessionForwardDispatchKey({ sessionId: null, messageId: 'm', forwardId: 'f', occurrence: 0 }),
    ).toBeNull();
  });
});

describe('sessionForwardDispatchKeyPrefix / parseSessionForwardDispatchKey', () => {
  const key = sessionForwardDispatchKey({
    sessionId: 'chat-1',
    messageId: 'm-1',
    forwardId: 'fwd',
    occurrence: 2,
  })!;

  it('the prefix matches every card key in the message and no other message', () => {
    expect(key.startsWith(sessionForwardDispatchKeyPrefix('chat-1', 'm-1'))).toBe(true);
    expect(key.startsWith(sessionForwardDispatchKeyPrefix('chat-1', 'm-10'))).toBe(false);
  });

  it('parses the chat and message back out of a key', () => {
    expect(parseSessionForwardDispatchKey(key)).toEqual({ sessionId: 'chat-1', messageId: 'm-1' });
    expect(parseSessionForwardDispatchKey('some-other-key')).toBeNull();
    expect(parseSessionForwardDispatchKey(null)).toBeNull();
  });
});
