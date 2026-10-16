import { describe, expect, it } from 'vitest';
import { withRestoredSession } from './sessionRestore';

describe('withRestoredSession', () => {
  const live: Array<{ id?: string; agent_id?: string }> = [{ id: 's1', agent_id: 'a' }];

  it("prepends the active agent's restored session", () => {
    expect(withRestoredSession(live, { id: 's2', agent_id: 'a' }, 'a')).toEqual([
      { id: 's2', agent_id: 'a' },
      ...live,
    ]);
  });

  it("leaves the list alone for another agent's session", () => {
    expect(withRestoredSession(live, { id: 's3', agent_id: 'b' }, 'a')).toBe(live);
  });

  it('ignores duplicates and rows without an id', () => {
    expect(withRestoredSession(live, { id: 's1', agent_id: 'a' }, 'a')).toBe(live);
    expect(withRestoredSession(live, { agent_id: 'a' }, 'a')).toBe(live);
    expect(withRestoredSession(live, null, 'a')).toBe(live);
  });
});
