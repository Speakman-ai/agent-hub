import { describe, expect, it } from 'vitest';
import { mergeIncomingMessage } from './mergeIncomingMessage';

describe('mergeIncomingMessage', () => {
  it('appends a message with a new id', () => {
    const prev = [{ id: 'a', role: 'user' }];
    expect(mergeIncomingMessage(prev, { id: 'b', role: 'system' })).toEqual([
      { id: 'a', role: 'user' },
      { id: 'b', role: 'system' },
    ]);
  });

  it('replaces a re-broadcast system row in place', () => {
    const prev = [
      { id: 'a', role: 'system', content: 'Rebase completed · round 2' },
      { id: 'b', role: 'user' },
    ];
    const next = mergeIncomingMessage(prev, {
      id: 'a',
      role: 'system',
      content: 'Rebase completed · round 2 · keeping the earlier passing result for e2e',
    });
    expect(next[0].content).toContain('e2e');
    expect(next).toHaveLength(2);
  });

  it('keeps the held copy of a duplicate non-system message', () => {
    const prev = [{ id: 'a', role: 'assistant', content: 'original' }];
    expect(mergeIncomingMessage(prev, { id: 'a', role: 'assistant', content: 'x' })).toBe(prev);
  });
});
