import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

vi.mock('../utils/export', () => ({ copyToClipboard: vi.fn() }));

import { copyToClipboard } from '../utils/export';
import CopyBranchButton from './CopyBranchButton';

const copyMock = copyToClipboard as unknown as ReturnType<typeof vi.fn>;

describe('CopyBranchButton', () => {
  beforeEach(() => copyMock.mockReset());

  it('copies the branch name and shows a copied state', async () => {
    copyMock.mockResolvedValue(true);
    render(<CopyBranchButton branch="feature/foo" />);
    fireEvent.click(screen.getByTestId('copy-branch-button'));
    expect(copyMock).toHaveBeenCalledWith('feature/foo');
    await waitFor(() =>
      expect(screen.getByTestId('copy-branch-button').getAttribute('aria-label')).toBe(
        'Copied branch name',
      ),
    );
  });

  it('does not trigger a parent click handler', () => {
    copyMock.mockResolvedValue(true);
    const parent = vi.fn();
    render(
      <div onClick={parent}>
        <CopyBranchButton branch="x" />
      </div>,
    );
    fireEvent.click(screen.getByTestId('copy-branch-button'));
    expect(parent).not.toHaveBeenCalled();
  });

  it('stays in the idle state when the copy fails', async () => {
    copyMock.mockResolvedValue(false);
    render(<CopyBranchButton branch="x" />);
    fireEvent.click(screen.getByTestId('copy-branch-button'));
    await waitFor(() => expect(copyMock).toHaveBeenCalled());
    expect(screen.getByTestId('copy-branch-button').getAttribute('aria-label')).toBe(
      'Copy branch name x',
    );
  });

  it('renders nothing without a branch', () => {
    const { container } = render(<CopyBranchButton branch="" />);
    expect(container.firstChild).toBeNull();
  });
});
