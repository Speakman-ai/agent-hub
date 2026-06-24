import { describe, it, expect } from 'vitest';
import { phaseComplete, phaseProgress } from './epicScopeStats';

const columns = { c1: 'To Do', c2: 'In Progress', c3: 'Done' };

describe('phaseComplete', () => {
  it('is false for a phase with no tickets', () => {
    expect(phaseComplete([], columns)).toBe(false);
  });

  it('is false while at least one ticket is not Done', () => {
    const tickets = [{ column_id: 'c3' }, { column_id: 'c2' }];
    expect(phaseComplete(tickets, columns)).toBe(false);
  });

  it('is true when every ticket is in the Done column', () => {
    const tickets = [{ column_id: 'c3' }, { column_id: 'c3' }];
    expect(phaseComplete(tickets, columns)).toBe(true);
    expect(phaseProgress(tickets, columns)).toBe(100);
  });

  it('treats the Done column case-insensitively', () => {
    const tickets = [{ column_id: 'c3' }];
    expect(phaseComplete(tickets, { c3: 'DONE' })).toBe(true);
  });

  it('is false when a ticket points at an unknown column', () => {
    const tickets = [{ column_id: 'c3' }, { column_id: 'missing' }];
    expect(phaseComplete(tickets, columns)).toBe(false);
  });
});
