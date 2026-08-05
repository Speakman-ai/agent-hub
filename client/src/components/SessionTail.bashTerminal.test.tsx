import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { ToolCard } from './SessionTail';
import { RunInTerminalProvider } from './RunInTerminalContext';

/**
 * Bash ToolCard — Cursor-style terminal view.
 *
 * Previously the expanded body of a Bash tool call rendered as a generic
 * "input (JSON)" + "result" panel, so users couldn't see the actual command
 * being executed at a glance. The terminal view replaces that with a
 * `$ <command>` line followed by the raw stdout/stderr, the way Cursor
 * renders it.
 *
 * These tests pin the contract:
 *  - The `$ <command>` block renders the literal command, no truncation.
 *  - The output is rendered after the command, in a single block (no JSON).
 *  - Non-Bash tools still go through the generic input/result rendering.
 */
describe('ToolCard — Bash terminal view', () => {
  const bashUse = {
    type: 'tool_use',
    id: 'bash-1',
    tool: 'Bash',
    input: {
      command: 'cd /repo && git push -u origin feature/cursor-chat-flow 2>&1 | tail -10',
      description: 'Push feature branch',
    },
  };
  const bashResult = {
    output: "remote: Create a pull request for 'feature/cursor-chat-flow'",
    isError: false,
  };

  it('shows the literal command on a $-prefixed line and the output below when expanded', () => {
    render(<ToolCard use={bashUse} result={bashResult} defaultOpen={true} />);

    const terminal = screen.getByTestId('bash-terminal');
    // Full command — including the chained `&&` and the redirect — is present
    // verbatim, not truncated. The `flex` wrapper splits the `$` and the
    // command into separate spans, so we assert against the inner text.
    expect(within(terminal).getByText(/cd \/repo && git push -u origin/)).toBeTruthy();
    expect(within(terminal).getByText('$')).toBeTruthy();
    // Output is rendered as raw text inside the same terminal block (not as
    // a JSON-formatted "input" pre).
    expect(within(terminal).getByText(/remote: Create a pull request/)).toBeTruthy();
    // The legacy "input" label must not render for Bash anymore.
    expect(within(terminal).queryByText(/^input$/i)).toBeNull();
  });

  it('renders a `running…` placeholder when the command has no result yet', () => {
    render(<ToolCard use={bashUse} result={undefined} defaultOpen={true} />);
    const terminal = screen.getByTestId('bash-terminal');
    expect(within(terminal).getByText(/running…/)).toBeTruthy();
  });

  it('falls back to the generic input/result panel for non-Bash tools', () => {
    const grepUse = {
      type: 'tool_use',
      id: 'g1',
      tool: 'Grep',
      input: { pattern: 'TODO', path: 'src/' },
    };
    const grepResult = { output: 'src/foo.ts:14: // TODO\n', isError: false };
    render(<ToolCard use={grepUse} result={grepResult} defaultOpen={true} />);
    expect(screen.queryByTestId('bash-terminal')).toBeNull();
    // The generic panel uses an "input" label.
    expect(screen.getByText(/^input$/i)).toBeTruthy();
  });

  it('does not show the terminal block when the card is collapsed', () => {
    render(<ToolCard use={bashUse} result={bashResult} defaultOpen={false} />);
    expect(screen.queryByTestId('bash-terminal')).toBeNull();
  });

  it('toggles the terminal block on click', () => {
    render(<ToolCard use={bashUse} result={bashResult} defaultOpen={false} />);
    const toggle = screen.getByRole('button');
    fireEvent.click(toggle as any);
    expect(screen.getByTestId('bash-terminal')).toBeTruthy();
  });

  describe('Run in terminal', () => {
    it('is absent outside the chat transcript, where there is no terminal', () => {
      render(<ToolCard use={bashUse} result={bashResult} defaultOpen={true} />);
      expect(screen.queryByTestId('bash-run-in-terminal')).toBeNull();
    });

    it('hands the literal command to the session terminal', () => {
      const onRun = vi.fn();
      render(
        <RunInTerminalProvider onRun={onRun}>
          <ToolCard use={bashUse} result={bashResult} defaultOpen={true} />
        </RunInTerminalProvider>,
      );

      fireEvent.click(screen.getByTestId('bash-run-in-terminal'));

      expect(onRun).toHaveBeenCalledWith(bashUse.input.command);
    });
  });
});
