import { describe, expect, it, vi } from 'vitest';
import { createHiddenSessionCheck } from './hidden-sessions.js';

describe('createHiddenSessionCheck', () => {
  it('flags broadcasts about hidden sessions, by sessionId or message row', () => {
    const lookup = vi.fn((id: string) => id === 'digest');
    const isHidden = createHiddenSessionCheck(lookup);
    expect(isHidden({ type: 'done', sessionId: 'digest' })).toBe(true);
    expect(isHidden({ type: 'message', message: { session_id: 'digest' } })).toBe(true);
    expect(isHidden({ type: 'done', sessionId: 'chat' })).toBe(false);
    expect(isHidden({ type: 'card_moved' })).toBe(false);
    // Cached after first sight.
    expect(lookup).toHaveBeenCalledTimes(2);
  });

  it('treats a failed lookup as visible', () => {
    const isHidden = createHiddenSessionCheck(() => {
      throw new Error('db closed');
    });
    expect(isHidden({ type: 'done', sessionId: 's' })).toBe(false);
  });
});
