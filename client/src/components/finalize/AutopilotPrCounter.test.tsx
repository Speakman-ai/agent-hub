import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';

vi.mock('../../utils/api.js', () => ({
  api: {
    getSessionDetail: vi.fn(),
  },
}));

import AutopilotPrCounter from './AutopilotPrCounter';
import { api } from '../../utils/api';

describe('AutopilotPrCounter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (api.getSessionDetail as ReturnType<typeof vi.fn>).mockResolvedValue({
      finalize_pushed_count: 3,
    });
  });

  it('renders the seeded committed-PR count', () => {
    render(<AutopilotPrCounter sessionId="s1" count={2} />);
    const badge = screen.getByTestId('autopilot-pr-counter');
    expect(badge).toHaveTextContent('2 PRs committed');
    expect(screen.queryByTestId('finalize-button')).not.toBeInTheDocument();
  });

  it('singularizes a single committed PR', () => {
    render(<AutopilotPrCounter sessionId="s1" count={1} />);
    expect(screen.getByTestId('autopilot-pr-counter')).toHaveTextContent('1 PR committed');
  });

  it('refreshes the count when this session pushes', async () => {
    render(<AutopilotPrCounter sessionId="s1" count={1} />);
    await act(async () => {
      window.dispatchEvent(
        new CustomEvent('finalize_run_completed', {
          detail: { session_id: 's1', status: 'pushed', run_id: 'run-2' },
        }),
      );
    });
    await waitFor(() => {
      expect(api.getSessionDetail).toHaveBeenCalledWith('s1');
      expect(screen.getByTestId('autopilot-pr-counter')).toHaveTextContent('3 PRs committed');
    });
  });

  it('ignores pushes for other sessions', async () => {
    render(<AutopilotPrCounter sessionId="s1" count={1} />);
    await act(async () => {
      window.dispatchEvent(
        new CustomEvent('finalize_run_completed', {
          detail: { session_id: 'other', status: 'pushed', run_id: 'run-9' },
        }),
      );
    });
    expect(api.getSessionDetail).not.toHaveBeenCalled();
    expect(screen.getByTestId('autopilot-pr-counter')).toHaveTextContent('1 PR committed');
  });
});
