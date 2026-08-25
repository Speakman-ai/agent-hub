// @ts-nocheck
import { describe, it, expect } from 'vitest';
import { truncateSessionId } from './sessionId';
describe('truncateSessionId', () => {
  it('shows the last 8 characters with an ellipsis prefix', () => {
    expect(truncateSessionId('sess-abcdef12345678')).toBe('…12345678');
  });
  it('returns short ids unchanged', () => {
    expect(truncateSessionId('short')).toBe('short');
    expect(truncateSessionId('12345678')).toBe('12345678');
  });
  it('handles empty input', () => {
    expect(truncateSessionId('')).toBe('');
    expect(truncateSessionId(null)).toBe(null);
    expect(truncateSessionId(undefined)).toBe(undefined);
  });
});
