import { describe, it, expect } from 'vitest';
import { pruneSessionScopedMap } from './pruneSessionScopedMap';

describe('pruneSessionScopedMap', () => {
  it('removes only the given ids and preserves the rest', () => {
    const map = { a: 1, b: 2, c: 3 };
    expect(pruneSessionScopedMap(map, ['b'])).toEqual({ a: 1, c: 3 });
  });

  it('preserves unrelated active-session state when clearing another agent', () => {
    // `browserScreensBySession` shape: sessionId -> screen state. Clearing an
    // inactive agent's sessions must NOT blank the active chat's sessions.
    const browserScreens = {
      'active-sess': { 'msg-1': 'screenshot' },
      'other-agent-sess-1': { 'msg-2': 'x' },
      'other-agent-sess-2': { 'msg-3': 'y' },
    };
    const removed = new Set(['other-agent-sess-1', 'other-agent-sess-2']);
    const next = pruneSessionScopedMap(browserScreens, removed);
    expect(next['active-sess']).toEqual({ 'msg-1': 'screenshot' });
    expect(next['other-agent-sess-1']).toBeUndefined();
    expect(next['other-agent-sess-2']).toBeUndefined();
  });

  it('returns the same reference when nothing is removed (no needless re-render)', () => {
    const map = { a: 1 };
    expect(pruneSessionScopedMap(map, [])).toBe(map);
  });

  it('accepts a Set or an array of ids', () => {
    const map = { a: 1, b: 2 };
    expect(pruneSessionScopedMap(map, new Set(['a']))).toEqual({ b: 2 });
    expect(pruneSessionScopedMap(map, ['a'])).toEqual({ b: 2 });
  });
});
