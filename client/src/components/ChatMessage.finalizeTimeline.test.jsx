import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import ChatMessage from './ChatMessage.jsx';

describe('ChatMessage finalize timeline routing', () => {
  it('returns null for finalize_step_output messages', () => {
    const { container } = render(
      <ChatMessage
        message={{
          role: 'system',
          metadata: JSON.stringify({
            kind: 'finalize_step_output',
            runId: 'run-1',
            stepIndex: 1,
          }),
          content: '[stdout] noisy line',
        }}
      />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('renders finalize review round block', () => {
    render(
      <ChatMessage
        message={{
          role: 'system',
          metadata: JSON.stringify({
            kind: 'finalize_review_round',
            runId: 'run-1',
            round: 1,
            verdict: 'approved',
            threads: [],
          }),
          content: 'Review · round 1 · approved',
        }}
      />,
    );
    expect(screen.getByTestId('finalize-review-round-block')).toBeInTheDocument();
  });
});
