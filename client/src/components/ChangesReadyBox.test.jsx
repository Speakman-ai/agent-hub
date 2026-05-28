import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import ChangesReadyBox from './ChangesReadyBox.jsx';

describe('ChangesReadyBox', () => {
  const baseProps = {
    sessionId: 'session-1',
    changes: { branch: 'feature/x', hasUncommitted: true, hasUnpushed: false },
    onTrigger: vi.fn(),
    onDismiss: vi.fn(),
    isSessionProcessing: false,
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders the Create ticket & PR button', () => {
    render(<ChangesReadyBox {...baseProps} />);
    expect(screen.getByTestId('create-ticket-pr-button')).toBeInTheDocument();
    expect(screen.getByText('Create ticket & PR')).toBeInTheDocument();
  });

  it('calls onTrigger with sessionId when clicked', async () => {
    const onTrigger = vi.fn().mockResolvedValue(undefined);
    render(<ChangesReadyBox {...baseProps} onTrigger={onTrigger} isSessionProcessing />);
    fireEvent.click(screen.getByTestId('create-ticket-pr-button'));
    await waitFor(() => {
      expect(onTrigger).toHaveBeenCalledWith('session-1');
    });
    expect(screen.getByText('Creating ticket & PR…')).toBeInTheDocument();
    expect(screen.getByTestId('create-ticket-pr-button')).toBeDisabled();
  });

  it('re-enables after the agent turn finishes', async () => {
    const onTrigger = vi.fn().mockResolvedValue(undefined);
    const { rerender } = render(
      <ChangesReadyBox {...baseProps} onTrigger={onTrigger} isSessionProcessing />,
    );
    fireEvent.click(screen.getByTestId('create-ticket-pr-button'));
    await waitFor(() => {
      expect(screen.getByText('Creating ticket & PR…')).toBeInTheDocument();
    });
    await act(async () => {
      rerender(
        <ChangesReadyBox {...baseProps} onTrigger={onTrigger} isSessionProcessing={false} />,
      );
    });
    await waitFor(() => {
      expect(screen.getByText('Create ticket & PR')).toBeInTheDocument();
    });
    expect(screen.getByTestId('create-ticket-pr-button')).not.toBeDisabled();
  });

  it('shows branch in title when changes.branch is set', () => {
    render(<ChangesReadyBox {...baseProps} />);
    expect(screen.getByTestId('create-ticket-pr-button')).toHaveAttribute(
      'title',
      'Create ticket & PR for feature/x',
    );
  });

  it('calls onDismiss when dismiss control is clicked', () => {
    const onDismiss = vi.fn();
    render(<ChangesReadyBox {...baseProps} onDismiss={onDismiss} />);
    fireEvent.click(screen.getByTestId('create-ticket-pr-dismiss'));
    expect(onDismiss).toHaveBeenCalledWith('session-1');
  });

  it('hides dismiss while creating', async () => {
    const onTrigger = vi.fn().mockResolvedValue(undefined);
    render(<ChangesReadyBox {...baseProps} onTrigger={onTrigger} isSessionProcessing />);
    fireEvent.click(screen.getByTestId('create-ticket-pr-button'));
    await waitFor(() => {
      expect(screen.queryByTestId('create-ticket-pr-dismiss')).not.toBeInTheDocument();
    });
  });
});
