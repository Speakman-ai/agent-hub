import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import ReactLoopObservabilityPanel from './ReactLoopObservabilityPanel.jsx';

describe('ReactLoopObservabilityPanel', () => {
  it('renders nothing when there are no steps', () => {
    const { container } = render(<ReactLoopObservabilityPanel steps={[]} streaming={false} />);
    expect(container.firstChild).toBeNull();
  });

  it('shows step summary and expands on click', () => {
    const steps = [
      {
        stepId: 'a:host:0:wiki',
        phase: 'host_action',
        tool: 'wiki',
        exitCode: 0,
        durationMs: 12,
        continuationDepth: 0,
        detail: 'q',
      },
    ];
    render(<ReactLoopObservabilityPanel steps={steps} streaming={false} />);
    expect(screen.getByText(/Loop steps/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Loop steps/i }));
    expect(screen.getByText(/host_action/)).toBeInTheDocument();
    expect(screen.getByText(/wiki/)).toBeInTheDocument();
  });
});
