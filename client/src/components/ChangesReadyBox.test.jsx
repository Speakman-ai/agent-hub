import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import ChangesReadyBox from './ChangesReadyBox.jsx';
import { api } from '../utils/api.js';

/**
 * ChangesReadyBox — auto-merge toggle default behavior.
 *
 * The per-PR auto-merge toggle should default to the project's
 * `githubWorkflow.autoMerge` setting (Layer 1), which the parent
 * passes in as `defaultAutoMerge`. The user can still flip it
 * locally before creating the PR (Layer 2 overrides Layer 1).
 */

vi.mock('../utils/api.js', () => ({
  api: {
    createPrFromSession: vi.fn(),
  },
}));

describe('ChangesReadyBox auto-merge default', () => {
  const baseProps = {
    sessionId: 'session-1',
    changes: {
      agentId: 'agent-1',
      branch: 'feature/foo',
      hasUncommitted: true,
      hasUnpushed: false,
    },
    onCreated: () => {},
    onDismiss: () => {},
  };

  beforeEach(() => {
    api.createPrFromSession.mockReset();
    api.createPrFromSession.mockResolvedValue({ prUrl: 'http://pr', cardId: 'c1' });
  });

  it('starts with the toggle ON when defaultAutoMerge is true', () => {
    render(<ChangesReadyBox {...baseProps} defaultAutoMerge={true} />);
    const toggle = screen.getByRole('switch');
    expect(toggle).toHaveAttribute('aria-checked', 'true');
  });

  it('starts with the toggle OFF when defaultAutoMerge is false', () => {
    render(<ChangesReadyBox {...baseProps} defaultAutoMerge={false} />);
    const toggle = screen.getByRole('switch');
    expect(toggle).toHaveAttribute('aria-checked', 'false');
  });

  it('starts with the toggle OFF when defaultAutoMerge is omitted', () => {
    render(<ChangesReadyBox {...baseProps} />);
    const toggle = screen.getByRole('switch');
    expect(toggle).toHaveAttribute('aria-checked', 'false');
  });

  it('allows the user to flip the toggle independently of the default (ON → OFF)', () => {
    render(<ChangesReadyBox {...baseProps} defaultAutoMerge={true} />);
    const toggle = screen.getByRole('switch');
    expect(toggle).toHaveAttribute('aria-checked', 'true');

    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-checked', 'false');
  });

  it('allows the user to flip the toggle independently of the default (OFF → ON)', () => {
    render(<ChangesReadyBox {...baseProps} defaultAutoMerge={false} />);
    const toggle = screen.getByRole('switch');
    expect(toggle).toHaveAttribute('aria-checked', 'false');

    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-checked', 'true');
  });

  it('calls api.createPrFromSession with the default autoMerge value when not toggled', async () => {
    render(<ChangesReadyBox {...baseProps} defaultAutoMerge={true} />);
    const createBtn = screen.getByRole('button', { name: /create ticket & pr/i });
    fireEvent.click(createBtn);

    await waitFor(() => {
      expect(api.createPrFromSession).toHaveBeenCalledTimes(1);
    });
    expect(api.createPrFromSession).toHaveBeenCalledWith('session-1', { autoMerge: true });
  });

  it('calls api.createPrFromSession with the locally flipped autoMerge value (Layer 2 overrides Layer 1)', async () => {
    render(<ChangesReadyBox {...baseProps} defaultAutoMerge={true} />);

    // User flips it OFF locally despite the project default being ON
    const toggle = screen.getByRole('switch');
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-checked', 'false');

    const createBtn = screen.getByRole('button', { name: /create ticket & pr/i });
    fireEvent.click(createBtn);

    await waitFor(() => {
      expect(api.createPrFromSession).toHaveBeenCalledTimes(1);
    });
    expect(api.createPrFromSession).toHaveBeenCalledWith('session-1', { autoMerge: false });
  });

  it('calls api.createPrFromSession with autoMerge=false when default is off and user does not toggle', async () => {
    render(<ChangesReadyBox {...baseProps} />);
    const createBtn = screen.getByRole('button', { name: /create ticket & pr/i });
    fireEvent.click(createBtn);

    await waitFor(() => {
      expect(api.createPrFromSession).toHaveBeenCalledTimes(1);
    });
    expect(api.createPrFromSession).toHaveBeenCalledWith('session-1', { autoMerge: false });
  });

  it('surfaces create-pr API error text in the inline error panel (Codex / multiline commit failures)', async () => {
    api.createPrFromSession.mockRejectedValueOnce(
      new Error('422: Git commit failed: pre-commit hook blocked the commit'),
    );
    render(<ChangesReadyBox {...baseProps} />);
    fireEvent.click(screen.getByRole('button', { name: /create ticket & pr/i }));

    await waitFor(() => {
      expect(screen.getByText(/Git commit failed/)).toBeInTheDocument();
    });
  });
});
