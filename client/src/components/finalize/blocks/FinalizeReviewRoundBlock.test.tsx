import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import FinalizeReviewRoundBlock from './FinalizeReviewRoundBlock';

describe('FinalizeReviewRoundBlock', () => {
  it('renders verdict and grouped threads', () => {
    render(
      <FinalizeReviewRoundBlock
        message={{
          metadata: JSON.stringify({
            kind: 'finalize_review_round',
            runId: 'run-1',
            round: 1,
            verdict: 'changes_requested',
            threads: [
              {
                id: 't1',
                file_path: 'src/foo.ts',
                line_start: 10,
                line_end: 12,
                body: 'Use const here',
              },
            ],
          }),
        }}
      />,
    );

    expect(screen.getByTestId('finalize-review-round-block')).toBeInTheDocument();
    expect(screen.getByTestId('finalize-review-verdict')).toHaveAttribute(
      'data-verdict',
      'changes_requested',
    );
    expect(screen.getByText('Use const here')).toBeInTheDocument();
    expect(screen.getByText(/Review · round 1/)).toBeInTheDocument();
  });

  it('labels approved rounds from verdict metadata', () => {
    render(
      <FinalizeReviewRoundBlock
        message={{
          content: 'Review · changes requested',
          metadata: JSON.stringify({
            kind: 'finalize_review_round',
            runId: 'run-1',
            round: 2,
            verdict: 'approved',
            threads: [],
          }),
        }}
      />,
    );

    const block = screen.getByTestId('finalize-review-round-block');
    expect(block!).toHaveAttribute('aria-label', 'Review · round 2 · approved');
    expect(screen.getByTestId('finalize-review-verdict')).toHaveAttribute(
      'data-verdict',
      'approved',
    );
    expect(block!).toHaveTextContent('Approved');
    expect(block!).not.toHaveTextContent('Changes requested');
  });

  it('labels changes-requested rounds from verdict metadata', () => {
    render(
      <FinalizeReviewRoundBlock
        message={{
          metadata: JSON.stringify({
            kind: 'finalize_review_round',
            runId: 'run-1',
            round: 3,
            verdict: 'changes_requested',
            threads: [],
          }),
        }}
      />,
    );

    const block = screen.getByTestId('finalize-review-round-block');
    expect(block!).toHaveAttribute('aria-label', 'Review · round 3 · changes requested');
    expect(screen.getByTestId('finalize-review-verdict')).toHaveAttribute(
      'data-verdict',
      'changes_requested',
    );
    expect(block!).toHaveTextContent('Changes requested');
  });
});
