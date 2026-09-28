import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

vi.mock('../../utils/api', () => ({
  api: {
    getSessionChanges: vi.fn(),
    discardSessionChanges: vi.fn(),
  },
}));

const { api } = await import('../../utils/api');
const { default: DiscardChangesButton } = await import('./DiscardChangesButton');

const CHANGES = {
  files: [
    { path: 'a.ts', additions: 12, deletions: 3 },
    { path: 'b.ts', additions: 1, deletions: 0 },
  ],
  truncated: false,
};

describe('DiscardChangesButton', () => {
  let confirmSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.mocked(api.getSessionChanges).mockReset().mockResolvedValue(CHANGES);
    vi.mocked(api.discardSessionChanges)
      .mockReset()
      .mockResolvedValue({ ok: true, discardedAt: '2026-09-28 17:00:00' });
    confirmSpy = vi.spyOn(window, 'confirm');
  });

  afterEach(() => {
    confirmSpy.mockRestore();
  });

  it('confirms with the diff size and irreversibility, then discards', async () => {
    confirmSpy.mockReturnValue(true);
    const onDiscarded = vi.fn();
    render(<DiscardChangesButton sessionId="s1" onDiscarded={onDiscarded} />);
    fireEvent.click(screen.getByTestId('discard-changes-button'));

    await waitFor(() => expect(onDiscarded).toHaveBeenCalled());
    const msg = String(confirmSpy.mock.calls[0][0]);
    expect(msg).toContain('2 files (+13 -3)');
    expect(msg).toContain('cannot be undone');
    expect(api.discardSessionChanges).toHaveBeenCalledWith('s1');
    expect(onDiscarded).toHaveBeenCalledWith({
      sessionId: 's1',
      discardedAt: '2026-09-28 17:00:00',
    });
  });

  it('does nothing when the operator cancels', async () => {
    confirmSpy.mockReturnValue(false);
    const onDiscarded = vi.fn();
    render(<DiscardChangesButton sessionId="s1" onDiscarded={onDiscarded} />);
    fireEvent.click(screen.getByTestId('discard-changes-button'));

    await waitFor(() => expect(confirmSpy).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByTestId('discard-changes-button')).not.toBeDisabled());
    expect(api.discardSessionChanges).not.toHaveBeenCalled();
    expect(onDiscarded).not.toHaveBeenCalled();
  });

  it('still asks when the diff cannot be loaded', async () => {
    vi.mocked(api.getSessionChanges).mockRejectedValue(new Error('boom'));
    confirmSpy.mockReturnValue(false);
    render(<DiscardChangesButton sessionId="s1" />);
    fireEvent.click(screen.getByTestId('discard-changes-button'));
    await waitFor(() => expect(confirmSpy).toHaveBeenCalled());
    expect(String(confirmSpy.mock.calls[0][0])).toContain('could not be loaded');
  });

  it('surfaces a server refusal and does not report success', async () => {
    confirmSpy.mockReturnValue(true);
    vi.mocked(api.discardSessionChanges).mockRejectedValue(new Error('A PR is open'));
    const onDiscarded = vi.fn();
    const onError = vi.fn();
    render(<DiscardChangesButton sessionId="s1" onDiscarded={onDiscarded} onError={onError} />);
    fireEvent.click(screen.getByTestId('discard-changes-button'));
    await waitFor(() => expect(onError).toHaveBeenCalledWith('A PR is open'));
    expect(onDiscarded).not.toHaveBeenCalled();
  });

  it('is disabled with the reason as tooltip when blocked', () => {
    render(<DiscardChangesButton sessionId="s1" blockedReason="Stop Finalize before discarding" />);
    const btn = screen.getByTestId('discard-changes-button');
    expect(btn).toBeDisabled();
    expect(btn).toHaveAttribute('title', 'Stop Finalize before discarding');
    fireEvent.click(btn);
    expect(confirmSpy).not.toHaveBeenCalled();
  });
});
