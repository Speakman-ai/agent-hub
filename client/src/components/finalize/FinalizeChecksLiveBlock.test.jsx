import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('../../hooks/useFinalizeRun.js', async () => {
  const actual = await vi.importActual('../../hooks/useFinalizeRun.js');
  return {
    ...actual,
    useFinalizeRun: vi.fn(),
  };
});

import { useFinalizeRun } from '../../hooks/useFinalizeRun.js';
import FinalizeChecksLiveBlock from './FinalizeChecksLiveBlock.jsx';

describe('FinalizeChecksLiveBlock', () => {
  it('renders live step rows during the tasks phase', () => {
    useFinalizeRun.mockReturnValue({
      run: { id: 'run-1', status: 'running', phase: 'tasks' },
      steps: [
        { index: 1, name: 'lint', state: 'passed', exitCode: 0, startedAt: 1, endedAt: 2 },
        { index: 2, name: 'test', state: 'running', exitCode: null, startedAt: 3, endedAt: null },
      ],
      phase: 'tasks',
      status: 'running',
    });

    render(<FinalizeChecksLiveBlock sessionId="sess-1" projectId="proj-1" />);
    expect(screen.getByTestId('finalize-checks-live-block')).toBeInTheDocument();
    expect(screen.getByText('test running…')).toBeInTheDocument();
    expect(screen.getByText('lint')).toBeInTheDocument();
  });

  it('renders nothing when finalize is not running checks', () => {
    useFinalizeRun.mockReturnValue({
      run: { id: 'run-1', status: 'reviewing', phase: 'review' },
      steps: [],
      phase: 'review',
      status: 'reviewing',
    });

    const { container } = render(<FinalizeChecksLiveBlock sessionId="sess-1" projectId="proj-1" />);
    expect(container.firstChild).toBeNull();
  });
});
