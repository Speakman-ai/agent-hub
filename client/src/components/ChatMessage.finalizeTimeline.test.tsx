import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import ChatMessage from './ChatMessage';

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
    expect(container!.firstChild).toBeNull();
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

  it('suppresses a raw reviewer verdict assistant message', () => {
    const { container } = render(
      <ChatMessage
        message={{
          role: 'assistant',
          content: JSON.stringify({
            verdict: 'changes_requested',
            threads: [
              {
                file_path: 'client/src/components/AccountSection.jsx',
                line_start: 352,
                line_end: 353,
                body: '**[4/10]** Fix the settings copy.',
              },
            ],
          }),
        }}
      />,
    );

    expect(container!.firstChild).toBeNull();
    expect(screen.queryByTestId('finalize-review-round-block')).not.toBeInTheDocument();
    expect(screen.queryByText('**[4/10]** Fix the settings copy.')).not.toBeInTheDocument();
    expect(screen.queryByText(/"verdict"/)).not.toBeInTheDocument();
  });

  it('routes approved review rounds without exposing stale changes-requested content', () => {
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
          content: 'Review · changes requested',
        }}
      />,
    );

    const block = screen.getByTestId('finalize-review-round-block');
    expect(block!).toHaveAttribute('aria-label', 'Review · round 1 · approved');
    expect(block!).toHaveTextContent('Approved');
    expect(block!).not.toHaveTextContent('Changes requested');
  });
});
