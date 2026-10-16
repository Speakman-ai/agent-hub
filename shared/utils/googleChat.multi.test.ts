import { describe, expect, it } from 'vitest';
import {
  dispatchWarningForMany,
  sharedThreadName,
  type ChatMessage,
  type ChatMessageLink,
} from './googleChat';

const m = (threadName: string | null) => ({ threadName }) as ChatMessage;

describe('sharedThreadName', () => {
  it('returns the thread only when every message shares it in a threaded space', () => {
    expect(sharedThreadName([m('t1'), m('t1')], true)).toBe('t1');
    expect(sharedThreadName([m('t1'), m('t2')], true)).toBeNull();
    expect(sharedThreadName([m('t1'), m('t1')], false)).toBeNull();
    expect(sharedThreadName([], true)).toBeNull();
  });
});

describe('dispatchWarningForMany', () => {
  const state = (names: string[]) => ({
    seq: 1,
    failed: false,
    links: names.map((messageName, i) => ({
      id: `L${i}`,
      messageName,
      sessionId: `s${i}`,
      sessionName: 'S',
    })) as unknown as ChatMessageLink[],
  });

  it('warns when links are unknown', () => {
    expect(dispatchWarningForMany(undefined, ['a', 'b'])).toContain('these messages');
  });

  it('counts already-sent messages and is silent when none were sent', () => {
    expect(dispatchWarningForMany(state(['a', 'b']), ['a', 'b', 'c'])).toBe(
      '2 of the 3 selected messages were already sent to an agent. Starting another session dispatches them again.',
    );
    expect(dispatchWarningForMany(state(['z']), ['a', 'b'])).toBeNull();
  });
});
