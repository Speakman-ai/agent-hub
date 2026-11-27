import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import EpicScopeHeader from './EpicScopeHeader';

const epic = { id: 'e1', name: 'Checkout', manager_session_id: 's1', manager_agent_id: 'lead' };

describe('EpicScopeHeader manager link', () => {
  it('opens the epic manager thread', () => {
    const onOpenManager = vi.fn();
    render(
      <EpicScopeHeader
        epic={epic}
        phases={[]}
        tickets={[]}
        columns={[]}
        onOpenManager={onOpenManager}
      />,
    );
    fireEvent.click(screen.getByTestId('epic-open-manager'));
    expect(onOpenManager).toHaveBeenCalledTimes(1);
  });

  it('shows no link before the epic has a manager', () => {
    render(
      <EpicScopeHeader
        epic={{ id: 'e1', name: 'Checkout' }}
        phases={[]}
        tickets={[]}
        columns={[]}
      />,
    );
    expect(screen.queryByTestId('epic-open-manager')).toBeNull();
  });
});
