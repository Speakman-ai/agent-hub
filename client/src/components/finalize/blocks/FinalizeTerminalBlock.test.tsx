import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import FinalizeTerminalBlock from './FinalizeTerminalBlock';

function renderTerminal(payload: any, props: any = {}) {
  return render(
    <FinalizeTerminalBlock
      message={{ metadata: JSON.stringify({ kind: 'finalize_run_terminal', ...payload }) }}
      {...props}
    />,
  );
}

describe('FinalizeTerminalBlock', () => {
  it('renders a gated push as a plain success', () => {
    renderTerminal({ status: 'pushed' });
    expect(screen.getByText('Pushed to GitHub')).toBeInTheDocument();
    expect(screen.queryByText('Pushed to GitHub without tests or review')).not.toBeInTheDocument();
  });

  it('warns when a push bypassed tests and review', () => {
    renderTerminal({ status: 'pushed', bypassedGates: true });
    expect(screen.getByText('Pushed to GitHub without tests or review')).toBeInTheDocument();
    expect(
      screen.getByText('Review and checks did not both pass before this push.'),
    ).toBeInTheDocument();
  });

  it('renders a clickable PR link when a successful push carries a prUrl', () => {
    renderTerminal({ status: 'pushed', prUrl: 'https://github.com/acme/repo/pull/42' });
    const link = screen.getByTestId('finalize-terminal-pr-link');
    expect(link!).toHaveAttribute('href', 'https://github.com/acme/repo/pull/42');
    expect(link!).toHaveTextContent('View PR #42');
  });

  it('renders the PR link for a bypassed push too', () => {
    renderTerminal({
      status: 'pushed',
      bypassedGates: true,
      prUrl: 'https://github.com/acme/repo/pull/7',
    });
    const link = screen.getByTestId('finalize-terminal-pr-link');
    expect(link!).toHaveAttribute('href', 'https://github.com/acme/repo/pull/7');
  });

  it('opens the in-app PR detail for an Agent Hub-native PR URL', () => {
    const onOpenPrDetail = vi.fn();
    renderTerminal(
      { status: 'pushed', prUrl: '/projects/surveytracker/pulls/356' },
      { onOpenPrDetail },
    );
    const link = screen.getByTestId('finalize-terminal-pr-link');
    // Clickable button (not a dead chip), labelled with the PR number.
    expect(link.tagName).toBe('BUTTON');
    expect(link).toHaveTextContent('View PR #356');
    fireEvent.click(link);
    expect(onOpenPrDetail).toHaveBeenCalledWith('surveytracker', 356);
  });

  it('falls back to a non-clickable native PR chip when no navigation handler is wired', () => {
    renderTerminal({ status: 'pushed', prUrl: '/projects/surveytracker/pulls/356' });
    const link = screen.getByTestId('finalize-terminal-pr-link');
    expect(link.tagName).toBe('SPAN');
    expect(link).toHaveTextContent('PR #356 (Pull Requests page)');
  });

  it('keeps GitHub PRs as external anchor links even when a nav handler is passed', () => {
    const onOpenPrDetail = vi.fn();
    renderTerminal(
      { status: 'pushed', prUrl: 'https://github.com/acme/repo/pull/42' },
      { onOpenPrDetail },
    );
    const link = screen.getByTestId('finalize-terminal-pr-link');
    expect(link.tagName).toBe('A');
    expect(link).toHaveAttribute('href', 'https://github.com/acme/repo/pull/42');
    expect(onOpenPrDetail).not.toHaveBeenCalled();
  });

  it('omits the PR link when no prUrl is present', () => {
    renderTerminal({ status: 'pushed' });
    expect(screen.queryByTestId('finalize-terminal-pr-link')).not.toBeInTheDocument();
  });

  it('does not render a PR link for non-push terminal statuses', () => {
    renderTerminal({ status: 'failed', prUrl: 'https://github.com/acme/repo/pull/9' });
    expect(screen.queryByTestId('finalize-terminal-pr-link')).not.toBeInTheDocument();
  });

  it('pairs a failure reason code with a human explanation', () => {
    renderTerminal({ status: 'failed', failureReason: 'fix_no_progress' });
    // The bare code stays for operators who know the vocabulary...
    expect(screen.getByText('Failed (fix_no_progress)')).toBeInTheDocument();
    // ...and a plain-English line explains it so it does not read as
    // "the run just stopped".
    const explanation = screen.getByTestId('finalize-terminal-explanation');
    expect(explanation!).toHaveTextContent(/did not land a new commit/i);
  });

  it('omits the explanation line for an unknown failure reason', () => {
    renderTerminal({ status: 'failed', failureReason: 'totally_made_up' });
    expect(screen.getByText('Failed (totally_made_up)')).toBeInTheDocument();
    expect(screen.queryByTestId('finalize-terminal-explanation')).not.toBeInTheDocument();
  });

  it('does not show a failure explanation on a successful push', () => {
    renderTerminal({ status: 'pushed', failureReason: 'fix_no_progress' });
    expect(screen.queryByTestId('finalize-terminal-explanation')).not.toBeInTheDocument();
  });

  it('returns null for non-finalize metadata', () => {
    const { container } = render(
      <FinalizeTerminalBlock message={{ metadata: JSON.stringify({ kind: 'pr_created' }) }} />,
    );
    expect(container!).toBeEmptyDOMElement();
  });
});
