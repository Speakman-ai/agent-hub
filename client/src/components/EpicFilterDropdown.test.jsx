import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import EpicFilterDropdown from './EpicFilterDropdown.jsx';

const epics = [
  { id: 'e1', name: 'Platform', color: '#6366F1', autonomous: 1 },
  { id: 'e2', name: 'Mobile', color: '#22C55E', autonomous: 0 },
];

describe('EpicFilterDropdown', () => {
  it('opens the menu and selects an epic', () => {
    const onSelect = vi.fn();
    render(
      <EpicFilterDropdown
        epics={epics}
        selectedEpicId={null}
        onSelect={onSelect}
        epicCardCount={(id) => (id === 'e1' ? 3 : 1)}
      />,
    );

    fireEvent.click(screen.getByRole('button', { expanded: false }));
    fireEvent.click(screen.getByRole('option', { name: /Platform/i }));
    expect(onSelect).toHaveBeenCalledWith('e1');
  });

  it('hides epics with no active cards from the menu', () => {
    render(
      <EpicFilterDropdown
        epics={epics}
        selectedEpicId={null}
        onSelect={vi.fn()}
        epicCardCount={(id) => (id === 'e1' ? 3 : 0)}
      />,
    );

    fireEvent.click(screen.getByRole('button', { expanded: false }));
    expect(screen.getByRole('option', { name: /Platform/i })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: /Mobile/i })).not.toBeInTheDocument();
  });

  it('keeps the selected epic in the menu even with 0 active cards', () => {
    render(
      <EpicFilterDropdown
        epics={epics}
        selectedEpicId="e2"
        onSelect={vi.fn()}
        epicCardCount={() => 0}
      />,
    );

    fireEvent.click(screen.getByRole('button', { expanded: false }));
    expect(screen.getByRole('option', { name: /Mobile/i })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: /Platform/i })).not.toBeInTheDocument();
  });

  it('shows the selected epic on the trigger', () => {
    render(
      <EpicFilterDropdown
        epics={epics}
        selectedEpicId="e1"
        onSelect={vi.fn()}
        epicCardCount={() => 2}
      />,
    );

    expect(screen.getByText('Platform')).toBeInTheDocument();
  });
});
