import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import FinalizeTerminalBlock from './FinalizeTerminalBlock.jsx';

function renderTerminal(payload) {
  return render(
    <FinalizeTerminalBlock
      message={{ metadata: JSON.stringify({ kind: 'finalize_run_terminal', ...payload }) }}
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

  it('returns null for non-finalize metadata', () => {
    const { container } = render(
      <FinalizeTerminalBlock message={{ metadata: JSON.stringify({ kind: 'pr_created' }) }} />,
    );
    expect(container).toBeEmptyDOMElement();
  });
});
