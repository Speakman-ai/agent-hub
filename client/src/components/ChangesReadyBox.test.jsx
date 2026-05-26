import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import ChangesReadyBox from './ChangesReadyBox.jsx';
import { api } from '../utils/api.js';

/**
 * ChangesReadyBox — split-button placement next to the Preview button.
 *
 * The compact split button shows "Create ticket & PR" as its primary
 * action and a caret toggle that expands a small popover with the
 * auto-merge switch, dismiss, error, and live publish log. The popover
 * auto-opens while a request is in flight, while a live log is
 * streaming, or when an error needs to be shown.
 *
 * The per-PR auto-merge toggle defaults to the project's
 * `githubWorkflow.autoMerge` setting (Layer 1) and the user can flip it
 * locally before creating the PR (Layer 2 overrides Layer 1).
 */

vi.mock('../utils/api.js', () => ({
  api: {
    createPrFromSession: vi.fn(),
  },
}));

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

/** Open the auto-merge popover by clicking the caret. */
function openPopover() {
  fireEvent.click(screen.getByTestId('create-ticket-pr-caret'));
}

beforeEach(() => {
  api.createPrFromSession.mockReset();
  api.createPrFromSession.mockResolvedValue({ prUrl: 'http://pr', cardId: 'c1' });
});

describe('ChangesReadyBox compact split-button layout', () => {
  it('renders the primary "Create ticket & PR" action without expanding the popover', () => {
    render(<ChangesReadyBox {...baseProps} />);
    expect(screen.getByTestId('create-ticket-pr-button')).toBeInTheDocument();
    expect(screen.getByTestId('create-ticket-pr-caret')).toBeInTheDocument();
    expect(screen.queryByTestId('create-ticket-pr-popover')).not.toBeInTheDocument();
    expect(screen.queryByRole('switch')).not.toBeInTheDocument();
  });

  it('expands the popover when the caret is clicked', () => {
    render(<ChangesReadyBox {...baseProps} />);
    openPopover();
    expect(screen.getByTestId('create-ticket-pr-popover')).toBeInTheDocument();
    expect(screen.getByRole('switch')).toBeInTheDocument();
  });

  it('collapses the popover on a second caret click', () => {
    render(<ChangesReadyBox {...baseProps} />);
    openPopover();
    expect(screen.getByTestId('create-ticket-pr-popover')).toBeInTheDocument();
    openPopover();
    expect(screen.queryByTestId('create-ticket-pr-popover')).not.toBeInTheDocument();
  });
});

describe('ChangesReadyBox auto-merge default', () => {
  it('starts with the toggle ON when defaultAutoMerge is true', () => {
    render(<ChangesReadyBox {...baseProps} defaultAutoMerge={true} />);
    openPopover();
    expect(screen.getByRole('switch')).toHaveAttribute('aria-checked', 'true');
  });

  it('starts with the toggle OFF when defaultAutoMerge is false', () => {
    render(<ChangesReadyBox {...baseProps} defaultAutoMerge={false} />);
    openPopover();
    expect(screen.getByRole('switch')).toHaveAttribute('aria-checked', 'false');
  });

  it('starts with the toggle OFF when defaultAutoMerge is omitted', () => {
    render(<ChangesReadyBox {...baseProps} />);
    openPopover();
    expect(screen.getByRole('switch')).toHaveAttribute('aria-checked', 'false');
  });

  it('allows the user to flip the toggle independently of the default (ON → OFF)', () => {
    render(<ChangesReadyBox {...baseProps} defaultAutoMerge={true} />);
    openPopover();
    const toggle = screen.getByRole('switch');
    expect(toggle).toHaveAttribute('aria-checked', 'true');

    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-checked', 'false');
  });

  it('allows the user to flip the toggle independently of the default (OFF → ON)', () => {
    render(<ChangesReadyBox {...baseProps} defaultAutoMerge={false} />);
    openPopover();
    const toggle = screen.getByRole('switch');
    expect(toggle).toHaveAttribute('aria-checked', 'false');

    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-checked', 'true');
  });

  it('calls api.createPrFromSession with the default autoMerge value when not toggled', async () => {
    render(<ChangesReadyBox {...baseProps} defaultAutoMerge={true} />);
    fireEvent.click(screen.getByTestId('create-ticket-pr-button'));

    await waitFor(() => {
      expect(api.createPrFromSession).toHaveBeenCalledTimes(1);
    });
    expect(api.createPrFromSession).toHaveBeenCalledWith('session-1', { autoMerge: true });
  });

  it('calls api.createPrFromSession with the locally flipped autoMerge value (Layer 2 overrides Layer 1)', async () => {
    render(<ChangesReadyBox {...baseProps} defaultAutoMerge={true} />);

    // User opens the popover and flips it OFF locally despite the project default being ON
    openPopover();
    const toggle = screen.getByRole('switch');
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-checked', 'false');

    fireEvent.click(screen.getByTestId('create-ticket-pr-button'));

    await waitFor(() => {
      expect(api.createPrFromSession).toHaveBeenCalledTimes(1);
    });
    expect(api.createPrFromSession).toHaveBeenCalledWith('session-1', { autoMerge: false });
  });

  it('calls api.createPrFromSession with autoMerge=false when default is off and user does not toggle', async () => {
    render(<ChangesReadyBox {...baseProps} />);
    fireEvent.click(screen.getByTestId('create-ticket-pr-button'));

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
    fireEvent.click(screen.getByTestId('create-ticket-pr-button'));

    // The popover should auto-open on error so the message is visible.
    await waitFor(() => {
      expect(screen.getByTestId('create-ticket-pr-popover')).toBeInTheDocument();
      expect(screen.getByText(/Git commit failed/)).toBeInTheDocument();
    });
  });

  it('calls onPublishStart before starting the create-PR request', () => {
    const onPublishStart = vi.fn();
    render(<ChangesReadyBox {...baseProps} onPublishStart={onPublishStart} />);
    fireEvent.click(screen.getByTestId('create-ticket-pr-button'));
    expect(onPublishStart).toHaveBeenCalledWith('session-1');
    expect(api.createPrFromSession).toHaveBeenCalled();
  });

  it('shows the publish log panel while loading and renders streamed livePrLog text', async () => {
    let resolvePr;
    api.createPrFromSession.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolvePr = resolve;
        }),
    );
    const { rerender } = render(<ChangesReadyBox {...baseProps} livePrLog="" />);
    fireEvent.click(screen.getByTestId('create-ticket-pr-button'));

    // Popover should auto-open while loading.
    await waitFor(() => {
      expect(screen.getByTestId('create-ticket-pr-popover')).toBeInTheDocument();
      expect(screen.getByText('Publish log')).toBeInTheDocument();
    });
    expect(screen.getByText(/Starting/)).toBeInTheDocument();

    rerender(<ChangesReadyBox {...baseProps} livePrLog={'$ git commit\nhusky - pre-commit\n'} />);
    expect(screen.getByText(/husky - pre-commit/)).toBeInTheDocument();

    resolvePr({ prUrl: 'http://pr', cardId: 'c1' });
    await waitFor(() => {
      expect(screen.getByTestId('create-ticket-pr-button')).not.toBeDisabled();
    });
  });

  it('keeps the popover open while livePrLog is streaming even if the user clicks the caret', () => {
    render(<ChangesReadyBox {...baseProps} livePrLog="$ git push\n" />);
    // The popover is forced open because there is a streaming log.
    expect(screen.getByTestId('create-ticket-pr-popover')).toBeInTheDocument();
    expect(screen.getByText(/git push/)).toBeInTheDocument();

    // A caret click should not be able to dismiss it while streaming.
    fireEvent.click(screen.getByTestId('create-ticket-pr-caret'));
    expect(screen.getByTestId('create-ticket-pr-popover')).toBeInTheDocument();
  });
});

/**
 * Always-on rendering — `App.jsx` now mounts this component whenever a
 * session is open, even before the server has reported a `changes_ready`
 * event. The component must tolerate a missing or partially-populated
 * `changes` prop and let the server's 4xx/422 response surface inline when
 * the user clicks anyway.
 */
describe('ChangesReadyBox tolerates missing changes prop', () => {
  it('renders the button when `changes` is undefined', () => {
    render(<ChangesReadyBox sessionId="s1" />);
    expect(screen.getByTestId('create-ticket-pr-button')).toBeInTheDocument();
  });

  it('uses a generic tooltip and omits the branch label when branch is empty', () => {
    render(
      <ChangesReadyBox
        sessionId="s1"
        changes={{ agentId: 'a1', branch: '', hasUncommitted: false, hasUnpushed: false }}
      />,
    );
    const btn = screen.getByTestId('create-ticket-pr-button');
    expect(btn).toHaveAttribute('title', 'Create ticket & PR');
  });

  it('shows the branch in the tooltip when branch is present', () => {
    render(
      <ChangesReadyBox
        sessionId="s1"
        changes={{ agentId: 'a1', branch: 'feature/x', hasUncommitted: false, hasUnpushed: false }}
      />,
    );
    const btn = screen.getByTestId('create-ticket-pr-button');
    expect(btn).toHaveAttribute('title', 'Create ticket & PR for feature/x');
  });

  it('surfaces a server 400 "no worktree" error inline when the user clicks with nothing to commit', async () => {
    api.createPrFromSession.mockRejectedValueOnce(
      new Error('400: Session has no worktree — nothing to commit'),
    );
    render(<ChangesReadyBox sessionId="s1" />);
    fireEvent.click(screen.getByTestId('create-ticket-pr-button'));

    await waitFor(() => {
      expect(screen.getByTestId('create-ticket-pr-popover')).toBeInTheDocument();
      expect(screen.getByText(/no worktree/)).toBeInTheDocument();
    });
  });

  it('surfaces a server 403 workflow-mode rejection inline', async () => {
    api.createPrFromSession.mockRejectedValueOnce(
      new Error('403: Session PR creation is disabled while this project is in workflow mode'),
    );
    render(<ChangesReadyBox sessionId="s1" />);
    fireEvent.click(screen.getByTestId('create-ticket-pr-button'));

    await waitFor(() => {
      expect(screen.getByText(/workflow mode/)).toBeInTheDocument();
    });
  });

  it('surfaces a server 409 "session streaming" rejection inline', async () => {
    api.createPrFromSession.mockRejectedValueOnce(
      new Error(
        '409: Session is still streaming — wait for the agent to finish before creating a PR',
      ),
    );
    render(<ChangesReadyBox sessionId="s1" />);
    fireEvent.click(screen.getByTestId('create-ticket-pr-button'));

    await waitFor(() => {
      expect(screen.getByTestId('create-ticket-pr-popover')).toBeInTheDocument();
      expect(screen.getByText(/still streaming/)).toBeInTheDocument();
    });
  });

  it('surfaces a server 409 resolve-PR rejection inline', async () => {
    api.createPrFromSession.mockRejectedValueOnce(
      new Error(
        '409: This session is a Resolve PR session — push fixes to the existing PR rather than opening a new one.',
      ),
    );
    render(<ChangesReadyBox sessionId="s1" />);
    fireEvent.click(screen.getByTestId('create-ticket-pr-button'));

    await waitFor(() => {
      expect(screen.getByText(/Resolve PR session/)).toBeInTheDocument();
    });
  });
});
