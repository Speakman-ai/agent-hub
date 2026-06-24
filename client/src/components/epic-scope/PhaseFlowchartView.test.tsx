import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import PhaseFlowchartView from './PhaseFlowchartView';

const columns = [
  { id: 'c1', name: 'To Do' },
  { id: 'c2', name: 'In Progress' },
  { id: 'c3', name: 'Done' },
];

const phases = [
  { id: 'p1', name: 'Phase One', position: 0 },
  { id: 'p2', name: 'Phase Two', position: 1 },
];

function renderView(tickets: any[]) {
  return render(
    <PhaseFlowchartView phases={phases} tickets={tickets} columns={columns} phaseForms={{}} />,
  );
}

describe('PhaseFlowchartView phase completion shading', () => {
  it('marks a phase complete (green) when all its tickets are Done', () => {
    renderView([
      { id: 't1', phase_id: 'p1', column_id: 'c3' },
      { id: 't2', phase_id: 'p1', column_id: 'c3' },
      { id: 't3', phase_id: 'p2', column_id: 'c1' },
    ]);

    const donePhase = screen.getByTestId('phase-column-p1');
    expect(donePhase.getAttribute('data-complete')).toBe('true');
    expect(donePhase.className).toContain('emerald');
    // The "Done" badge renders inside the completed phase column.
    expect(donePhase.textContent).toContain('Done');

    const openPhase = screen.getByTestId('phase-column-p2');
    expect(openPhase.getAttribute('data-complete')).toBe('false');
    expect(openPhase.className).not.toContain('emerald');
  });

  it('does not mark an empty phase complete', () => {
    renderView([]);
    expect(screen.getByTestId('phase-column-p1').getAttribute('data-complete')).toBe('false');
  });

  it('does not mark a phase complete while a ticket is still open', () => {
    renderView([
      { id: 't1', phase_id: 'p1', column_id: 'c3' },
      { id: 't2', phase_id: 'p1', column_id: 'c2' },
    ]);
    expect(screen.getByTestId('phase-column-p1').getAttribute('data-complete')).toBe('false');
  });
});
