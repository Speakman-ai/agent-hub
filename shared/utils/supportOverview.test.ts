import { describe, it, expect } from 'vitest';
import {
  groupTicketsByProject,
  paginate,
  pageCount,
  clampPage,
  type OverviewTicketLike,
  type ProjectOption,
} from './supportOverview.js';

function ticket(id: string, project_id: string, severity?: string): OverviewTicketLike {
  return { id, project_id, severity, project_name: `${project_id} name` };
}

describe('groupTicketsByProject', () => {
  it('groups by project and orders sections by the projects option set', () => {
    const tickets = [
      ticket('t1', 'b', 'critical'),
      ticket('t2', 'a', 'high'),
      ticket('t3', 'b', 'low'),
      ticket('t4', 'a', 'medium'),
    ];
    // Option set is server-ordered (busiest first): a has 2, b has 2 → name tiebreak.
    const projects: ProjectOption[] = [
      { id: 'a', name: 'Alpha', count: 2 },
      { id: 'b', name: 'Bravo', count: 2 },
    ];
    const sections = groupTicketsByProject(tickets, projects);
    expect(sections.map((s) => s.id)).toEqual(['a', 'b']);
    expect(sections[0].name).toBe('Alpha');
    expect(sections[0].tickets.map((t) => t.id)).toEqual(['t2', 't4']);
    expect(sections[1].tickets.map((t) => t.id)).toEqual(['t1', 't3']);
  });

  it('omits projects with no tickets in the filtered set', () => {
    const tickets = [ticket('t1', 'a', 'high')];
    const projects: ProjectOption[] = [
      { id: 'a', name: 'Alpha', count: 1 },
      { id: 'b', name: 'Bravo', count: 5 }, // has tickets globally, none in this filter
    ];
    const sections = groupTicketsByProject(tickets, projects);
    expect(sections.map((s) => s.id)).toEqual(['a']);
  });

  it('tallies severity counts per section', () => {
    const tickets = [
      ticket('t1', 'a', 'critical'),
      ticket('t2', 'a', 'critical'),
      ticket('t3', 'a', 'low'),
      ticket('t4', 'a', 'bogus'), // unknown severity is ignored
    ];
    const [section] = groupTicketsByProject(tickets, [{ id: 'a', name: 'Alpha', count: 4 }]);
    expect(section.severityCounts).toEqual({ critical: 2, high: 0, medium: 0, low: 1 });
  });

  it('still sections a ticket whose project is absent from the option set', () => {
    const tickets = [ticket('t1', 'ghost', 'high')];
    const sections = groupTicketsByProject(tickets, []);
    expect(sections).toHaveLength(1);
    expect(sections[0].id).toBe('ghost');
    expect(sections[0].name).toBe('ghost name'); // falls back to ticket.project_name
  });
});

describe('pagination helpers', () => {
  it('pageCount is at least 1 and rounds up', () => {
    expect(pageCount(0, 5)).toBe(1);
    expect(pageCount(5, 5)).toBe(1);
    expect(pageCount(6, 5)).toBe(2);
    expect(pageCount(11, 5)).toBe(3);
  });

  it('clampPage keeps the page inside the valid range', () => {
    expect(clampPage(0, 12, 5)).toBe(1);
    expect(clampPage(99, 12, 5)).toBe(3); // 12 items / 5 = 3 pages
    expect(clampPage(2, 12, 5)).toBe(2);
    expect(clampPage(NaN, 12, 5)).toBe(1);
  });

  it('paginate returns the right slice and clamps out-of-range pages', () => {
    const items = [1, 2, 3, 4, 5, 6, 7];
    expect(paginate(items, 1, 3)).toEqual([1, 2, 3]);
    expect(paginate(items, 2, 3)).toEqual([4, 5, 6]);
    expect(paginate(items, 3, 3)).toEqual([7]);
    // Page past the end clamps to the last page rather than returning [].
    expect(paginate(items, 99, 3)).toEqual([7]);
  });
});
