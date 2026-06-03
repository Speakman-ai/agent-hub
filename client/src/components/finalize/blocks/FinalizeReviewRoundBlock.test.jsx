import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import FinalizeReviewRoundBlock from './FinalizeReviewRoundBlock.jsx';

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
});
