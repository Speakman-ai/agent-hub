import { describe, expect, it } from 'vitest';
import {
  columnNameById,
  isColumnDone,
  ticketsForEpic,
  phasesForEpic,
  ticketsForPhase,
  countDoneTickets,
  phaseProgress,
  phaseComplete,
  epicAutonomousSummary,
  specProgress,
  specStatusLabel,
} from './epicScopeStats';

const columns = [
  { id: 'c1', name: 'To Do' },
  { id: 'c2', name: 'In Progress' },
  { id: 'c3', name: 'Done' },
];
const colMap = columnNameById(columns);

describe('epicScopeStats (mobile)', () => {
  it('maps column ids to names and flags the done column', () => {
    expect(colMap.c3).toBe('Done');
    expect(isColumnDone('Done')).toBe(true);
    expect(isColumnDone('done')).toBe(true);
    expect(isColumnDone('To Do')).toBe(false);
  });

  it('filters tickets by epic and phase', () => {
    const cards = [
      { id: 'a', epic_id: 'e1', phase_id: 'p1' },
      { id: 'b', epic_id: 'e1', phase_id: null },
      { id: 'c', epic_id: 'e2', phase_id: 'p1' },
    ];
    expect(ticketsForEpic(cards, 'e1').map((c) => c.id)).toEqual(['a', 'b']);
    expect(ticketsForPhase(cards, 'p1').map((c) => c.id)).toEqual(['a', 'c']);
  });

  it('sorts phases for an epic by position', () => {
    const phases = [
      { id: 'p2', epic_id: 'e1', position: 2 },
      { id: 'p1', epic_id: 'e1', position: 1 },
      { id: 'px', epic_id: 'e2', position: 0 },
    ];
    expect(phasesForEpic(phases, 'e1').map((p) => p.id)).toEqual(['p1', 'p2']);
  });

  it('computes done count, progress, and completion', () => {
    const tickets = [
      { id: 'a', column_id: 'c3' },
      { id: 'b', column_id: 'c1' },
    ];
    expect(countDoneTickets(tickets, colMap)).toBe(1);
    expect(phaseProgress(tickets, colMap)).toBe(50);
    expect(phaseComplete(tickets, colMap)).toBe(false);
    expect(phaseComplete([{ id: 'a', column_id: 'c3' }], colMap)).toBe(true);
    // An empty phase is never complete and reports 0% progress.
    expect(phaseComplete([], colMap)).toBe(false);
    expect(phaseProgress([], colMap)).toBe(0);
  });

  it('summarizes autonomous phases', () => {
    expect(epicAutonomousSummary([]).label).toBeNull();
    expect(epicAutonomousSummary([{ autonomous: 1 }, { autonomous: 1 }]).label).toBe('ALL AUTO');
    expect(epicAutonomousSummary([{ autonomous: 1 }, { autonomous: 0 }]).label).toBe('1 AUTO');
    expect(epicAutonomousSummary([{ autonomous: 0 }]).label).toBeNull();
  });

  it('computes spec progress and readiness', () => {
    const items = [
      { status: 'chosen' },
      { status: 'chosen' },
      { status: 'open' },
      { status: 'deferred' },
    ];
    const s = specProgress(items);
    expect(s.total).toBe(4);
    expect(s.chosen).toBe(2);
    expect(s.open).toBe(1);
    expect(s.deferred).toBe(1);
    expect(s.pct).toBe(50);
    expect(s.readyForImplementation).toBe(false);
    // No open decisions => ready.
    expect(specProgress([{ status: 'chosen' }]).readyForImplementation).toBe(true);
    // No spec items at all => not ready (nothing to implement against).
    expect(specProgress([]).readyForImplementation).toBe(false);
  });

  it('labels spec status', () => {
    expect(specStatusLabel('chosen')).toBe('Locked');
    expect(specStatusLabel('open')).toBe('Open');
    expect(specStatusLabel('deferred')).toBe('Deferred');
    expect(specStatusLabel(undefined)).toBe('Open');
  });

  it('counts missing/null/unknown status as open so it agrees with the label', () => {
    // Regression: a spec item without an explicit status renders as "Open" in
    // the UI, so it must also count as open — otherwise readyForImplementation
    // could flip true and unlock autonomous runs while a visibly-open decision
    // remains undecided.
    const items = [{ status: 'chosen' }, { status: null }, { status: undefined }, {}];
    const s = specProgress(items);
    expect(s.total).toBe(4);
    expect(s.chosen).toBe(1);
    expect(s.open).toBe(3);
    expect(s.chosen + s.open + s.deferred).toBe(s.total);
    expect(s.readyForImplementation).toBe(false);
    // Each undecided item is also labeled "Open" in the UI.
    expect(specStatusLabel(null)).toBe('Open');
    expect(specStatusLabel(undefined)).toBe('Open');
    expect(specStatusLabel('' as any)).toBe('Open');
  });
});
