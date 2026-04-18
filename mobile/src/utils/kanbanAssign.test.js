import { describe, it, expect } from 'vitest';
import {
  findAgentByName,
  hasActiveSession,
  buildAssigneeOptions,
} from './kanbanAssign.js';

describe('findAgentByName', () => {
  const agents = [
    { id: 'a1', name: 'Hub Lead' },
    { id: 'a2', name: 'Hub Backend' },
    { id: 'a3', name: 'Hub Mobile' },
  ];

  it('returns the matching agent by name', () => {
    expect(findAgentByName(agents, 'Hub Mobile')).toEqual({
      id: 'a3',
      name: 'Hub Mobile',
    });
  });

  it('returns undefined when no match', () => {
    expect(findAgentByName(agents, 'Nobody')).toBeUndefined();
  });

  it('returns undefined for empty inputs', () => {
    expect(findAgentByName([], 'Hub Lead')).toBeUndefined();
    expect(findAgentByName(null, 'Hub Lead')).toBeUndefined();
    expect(findAgentByName(agents, '')).toBeUndefined();
    expect(findAgentByName(agents, null)).toBeUndefined();
  });
});

describe('hasActiveSession', () => {
  it('is true when card has a session_id', () => {
    expect(hasActiveSession({ id: 'c1', session_id: 's1' })).toBe(true);
  });

  it('is false when session_id is missing or null', () => {
    expect(hasActiveSession({ id: 'c1' })).toBe(false);
    expect(hasActiveSession({ id: 'c1', session_id: null })).toBe(false);
    expect(hasActiveSession({ id: 'c1', session_id: '' })).toBe(false);
  });

  it('is false for null/undefined card', () => {
    expect(hasActiveSession(null)).toBe(false);
    expect(hasActiveSession(undefined)).toBe(false);
  });
});

describe('buildAssigneeOptions', () => {
  it('always prefixes an Unassigned row', () => {
    const opts = buildAssigneeOptions([{ id: 'a1', name: 'Foo' }]);
    expect(opts[0]).toEqual({ id: '', name: 'Unassigned' });
    expect(opts[1]).toEqual({ id: 'a1', name: 'Foo' });
  });

  it('filters out agents missing id or name', () => {
    const opts = buildAssigneeOptions([
      { id: 'a1', name: 'Foo' },
      { id: '', name: 'Bad' },
      { id: 'a2', name: '' },
      null,
      { id: 'a3', name: 'Bar' },
    ]);
    expect(opts).toEqual([
      { id: '', name: 'Unassigned' },
      { id: 'a1', name: 'Foo' },
      { id: 'a3', name: 'Bar' },
    ]);
  });

  it('handles non-array input gracefully', () => {
    expect(buildAssigneeOptions(null)).toEqual([
      { id: '', name: 'Unassigned' },
    ]);
    expect(buildAssigneeOptions(undefined)).toEqual([
      { id: '', name: 'Unassigned' },
    ]);
  });
});
