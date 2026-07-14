import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import UnassignedTicketsView from './UnassignedTicketsView';

const columns = [
  { id: 'todo', name: 'To Do' },
  { id: 'done', name: 'Done' },
];

const phases = [
  { id: 'phase-1', name: 'Foundation', position: 0 },
  { id: 'phase-2', name: 'UI', position: 1 },
];

describe('UnassignedTicketsView', () => {
  it('shows unphased tickets and assigns one to a selected phase', () => {
    const onAssignTicket = vi.fn();
    render(
      <UnassignedTicketsView
        tickets={[
          { id: 'ticket-1', title: 'Unphased ticket', column_id: 'todo', phase_id: null },
          { id: 'ticket-2', title: 'Already grouped', column_id: 'done', phase_id: 'phase-1' },
        ]}
        phases={phases}
        columns={columns}
        onAssignTicket={onAssignTicket}
      />,
    );

    expect(screen.getByTestId('unassigned-tickets')).toBeInTheDocument();
    expect(screen.getByText('Unphased ticket')).toBeInTheDocument();
    expect(screen.queryByText('Already grouped')).toBeNull();

    fireEvent.change(screen.getByTestId('assign-phase-ticket-1'), {
      target: { value: 'phase-2' },
    });

    expect(onAssignTicket).toHaveBeenCalledWith('ticket-1', 'phase-2');
  });

  it('renders nothing when every ticket belongs to a phase', () => {
    render(
      <UnassignedTicketsView
        tickets={[{ id: 'ticket-1', title: 'Grouped ticket', phase_id: 'phase-1' }]}
        phases={phases}
        columns={columns}
      />,
    );

    expect(screen.queryByTestId('unassigned-tickets')).toBeNull();
  });
});
