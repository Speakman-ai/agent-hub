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
