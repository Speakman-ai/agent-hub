import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
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

describe('PhaseFlowchartView reorder controls', () => {
  it('renders move controls only when onReorderPhases is provided', () => {
    const { rerender } = render(
      <PhaseFlowchartView phases={phases} tickets={[]} columns={columns} phaseForms={{}} />,
    );
    expect(screen.queryByTestId('phase-move-right-p1')).toBeNull();

    rerender(
      <PhaseFlowchartView
        phases={phases}
        tickets={[]}
        columns={columns}
        phaseForms={{}}
        onReorderPhases={() => {}}
      />,
    );
    expect(screen.getByTestId('phase-move-right-p1')).not.toBeNull();
  });

  it('moving a phase right calls onReorderPhases with the swapped order', () => {
    const onReorderPhases = vi.fn();
    render(
      <PhaseFlowchartView
        phases={phases}
        tickets={[]}
        columns={columns}
        phaseForms={{}}
        onReorderPhases={onReorderPhases}
      />,
    );
    fireEvent.click(screen.getByTestId('phase-move-right-p1'));
    expect(onReorderPhases).toHaveBeenCalledWith(['p2', 'p1']);
  });

  it('disables move-left on the first phase and move-right on the last', () => {
    render(
      <PhaseFlowchartView
        phases={phases}
        tickets={[]}
        columns={columns}
        phaseForms={{}}
        onReorderPhases={() => {}}
      />,
    );
    expect(screen.getByTestId('phase-move-left-p1')).toBeDisabled();
    expect(screen.getByTestId('phase-move-right-p2')).toBeDisabled();
  });
});

describe('PhaseFlowchartView Auto Merge toggle', () => {
  it('shows the Auto Merge toggle, checked, when the phase defaults to armed + auto-merge', () => {
    render(
      <PhaseFlowchartView
        phases={[{ id: 'p1', name: 'Phase One', position: 0 }]}
        tickets={[]}
        columns={columns}
        phaseForms={{ p1: { autonomous: 1, autonomous_send_it: 1, autonomous_max_concurrent: 1 } }}
      />,
    );

    const row = screen.getByTestId('phase-auto-merge-p1');
    expect(row.textContent).toContain('Auto Merge');
    expect(within(row).getByRole('switch').getAttribute('aria-checked')).toBe('true');
  });

  it('hides the Auto Merge toggle when auto-dispatch (arming) is off', () => {
    render(
      <PhaseFlowchartView
        phases={[{ id: 'p1', name: 'Phase One', position: 0 }]}
        tickets={[]}
        columns={columns}
        phaseForms={{ p1: { autonomous: 0, autonomous_send_it: 1 } }}
      />,
    );
    expect(screen.queryByTestId('phase-auto-merge-p1')).toBeNull();
  });

  it('toggling Auto Merge off emits autonomous_send_it: 0', () => {
    const onPhaseFormChange = vi.fn();
    render(
      <PhaseFlowchartView
        phases={[{ id: 'p1', name: 'Phase One', position: 0 }]}
        tickets={[]}
        columns={columns}
        phaseForms={{ p1: { autonomous: 1, autonomous_send_it: 1, autonomous_max_concurrent: 1 } }}
        onPhaseFormChange={onPhaseFormChange}
      />,
    );

    const row = screen.getByTestId('phase-auto-merge-p1');
    fireEvent.click(within(row).getByRole('switch'));

    expect(onPhaseFormChange).toHaveBeenCalledWith('p1', { autonomous_send_it: 0 });
  });
});

describe('PhaseFlowchartView model selector', () => {
  it('shows each phase model dropdown and emits autonomous_model changes', () => {
    const onPhaseFormChange = vi.fn();
    render(
      <PhaseFlowchartView
        phases={[{ id: 'p1', name: 'Phase One', position: 0 }]}
        tickets={[]}
        columns={columns}
        phaseForms={{
          p1: {
            autonomous: 1,
            autonomous_send_it: 1,
            autonomous_max_concurrent: 1,
            autonomous_model: 'gpt-5.5',
          },
        }}
        modelConfig={{
          engineValidModels: {
            'claude-code': ['claude-opus-4-8'],
            'codex-cli': ['gpt-5.5', 'gpt-5.4'],
          },
        }}
        onPhaseFormChange={onPhaseFormChange}
      />,
    );

    const select = screen.getByTestId('phase-model-p1') as HTMLSelectElement;
    expect(select.value).toBe('gpt-5.5');

    fireEvent.change(select, { target: { value: 'gpt-5.4' } });
    expect(onPhaseFormChange).toHaveBeenCalledWith('p1', { autonomous_model: 'gpt-5.4' });
  });

  it('keeps the phase model dropdown visible when auto-dispatch is off', () => {
    const onPhaseFormChange = vi.fn();
    render(
      <PhaseFlowchartView
        phases={[{ id: 'p1', name: 'Phase One', position: 0 }]}
        tickets={[]}
        columns={columns}
        phaseForms={{ p1: { autonomous: 0, autonomous_model: 'gpt-5.5' } }}
        modelConfig={{ engineValidModels: { 'codex-cli': ['gpt-5.5', 'gpt-5.4'] } }}
        onPhaseFormChange={onPhaseFormChange}
      />,
    );

    const select = screen.getByTestId('phase-model-p1') as HTMLSelectElement;
    expect(select.value).toBe('gpt-5.5');
    expect(screen.queryByText('Tickets at once')).toBeNull();

    fireEvent.change(select, { target: { value: 'gpt-5.4' } });
    expect(onPhaseFormChange).toHaveBeenCalledWith('p1', { autonomous_model: 'gpt-5.4' });
  });
});
