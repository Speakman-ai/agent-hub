import { describe, it, expect } from 'vitest';
import { isColumnCancelled, phaseComplete, phaseProgress, ticketsForEpic } from './epicScopeStats';

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

describe('isColumnCancelled', () => {
  it('matches both spellings, case-insensitively', () => {
    expect(isColumnCancelled('Canceled')).toBe(true);
    expect(isColumnCancelled('Cancelled')).toBe(true);
    expect(isColumnCancelled('CANCELED')).toBe(true);
    expect(isColumnCancelled("Won't do / Cancelled")).toBe(true);
  });

  it('does not match live or unrelated columns', () => {
    expect(isColumnCancelled('To Do')).toBe(false);
    expect(isColumnCancelled('In Progress')).toBe(false);
    expect(isColumnCancelled('Done')).toBe(false);
    expect(isColumnCancelled('')).toBe(false);
    expect(isColumnCancelled(null as any)).toBe(false);
  });
});

describe('ticketsForEpic — cancelled exclusion', () => {
  const boardColumns = [
    { id: 'c1', name: 'To Do' },
    { id: 'c3', name: 'Done' },
    { id: 'cx', name: 'Canceled' },
  ];
  const cards = [
    { id: 'a', epic_id: 'e1', column_id: 'c1' },
    { id: 'b', epic_id: 'e1', column_id: 'cx' }, // cancelled — must be dropped
    { id: 'c', epic_id: 'e2', column_id: 'c1' }, // other epic
    { id: 'd', epic_id: 'e1', column_id: 'c3' },
  ];

  it('excludes cancelled-column cards when columns are provided', () => {
    const tickets = ticketsForEpic(cards, 'e1', boardColumns);
    expect(tickets.map((t: any) => t.id)).toEqual(['a', 'd']);
  });

  it('keeps every epic card when columns are omitted (back-compat)', () => {
    const tickets = ticketsForEpic(cards, 'e1');
    expect(tickets.map((t: any) => t.id)).toEqual(['a', 'b', 'd']);
  });
});
