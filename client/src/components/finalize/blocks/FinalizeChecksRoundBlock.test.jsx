import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import FinalizeChecksRoundBlock from './FinalizeChecksRoundBlock.jsx';

vi.mock('../FinalizeStepLogModal.jsx', () => ({
  default: ({ open, stepName }) => (open ? <div data-testid="log-modal">{stepName}</div> : null),
}));

describe('FinalizeChecksRoundBlock', () => {
  it('renders step rows and opens log modal', async () => {
    render(
      <FinalizeChecksRoundBlock
        projectId="proj-1"
        message={{
          metadata: JSON.stringify({
            kind: 'finalize_checks_round',
            runId: 'run-1',
            round: 1,
            steps: [
              { index: 1, name: 'lint', state: 'passed', exitCode: 0, startedAt: 1, endedAt: 2 },
              { index: 2, name: 'test', state: 'failed', exitCode: 1, startedAt: 3, endedAt: 4 },
            ],
          }),
        }}
      />,
    );

    expect(screen.getByTestId('finalize-checks-round-block')).toBeInTheDocument();
    expect(screen.getByText('lint')).toBeInTheDocument();
    fireEvent.click(screen.getByText('test'));
    expect(await screen.findByTestId('log-modal')).toHaveTextContent('test');
  });
});
