import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('../../utils/api', () => ({
  api: { getSessionChanges: vi.fn(), discardSessionChanges: vi.fn() },
}));

vi.mock('../../hooks/useFinalizeRun', async () => {
  const actual: any = await vi.importActual('../../hooks/useFinalizeRun');
  return { ...actual, useFinalizeRun: vi.fn() };
});

const { useFinalizeRun } = await import('../../hooks/useFinalizeRun');
const { default: SessionDiscardMenuItem } = await import('./SessionDiscardMenuItem');

const withStatus = (status: string | null) =>
  vi.mocked(useFinalizeRun).mockReturnValue({ status } as any);

describe('SessionDiscardMenuItem', () => {
  beforeEach(() => vi.mocked(useFinalizeRun).mockReset());

  it('renders an enabled menu item when no Finalize run is open', () => {
    withStatus(null);
    render(<SessionDiscardMenuItem sessionId="s1" onDiscarded={vi.fn()} />);
    const btn = screen.getByTestId('discard-changes-button');
    expect(btn).not.toBeDisabled();
    expect(btn).toHaveTextContent('Discard changes');
  });

  it('disables while Finalize is running', () => {
    withStatus('running');
    render(<SessionDiscardMenuItem sessionId="s1" onDiscarded={vi.fn()} />);
    const btn = screen.getByTestId('discard-changes-button');
    expect(btn).toBeDisabled();
    expect(btn).toHaveAttribute('title', 'Stop Finalize before discarding');
  });

  it('disables when Finalize is parked at ready_to_push', () => {
    withStatus('ready_to_push');
    render(<SessionDiscardMenuItem sessionId="s1" onDiscarded={vi.fn()} />);
    expect(screen.getByTestId('discard-changes-button')).toBeDisabled();
  });
});
