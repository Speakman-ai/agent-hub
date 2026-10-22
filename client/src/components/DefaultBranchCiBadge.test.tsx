import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import DefaultBranchCiBadge from './DefaultBranchCiBadge';
import { api } from '../utils/api';

(vi as any).mock('../utils/api.js', () => ({
  api: { getCiRuns: vi.fn() },
}));

const pushRun = {
  id: 'r1',
  branch: 'main',
  head_sha: 'deadbeefcafe0000',
  status: 'failed',
  trigger_source: 'git_push',
  started_at: Date.now() - 60_000,
  ended_at: Date.now() - 30_000,
  jobs: [{ job_id: 'lint', matrix_key: 'default', state: 'failed' }],
};

describe('DefaultBranchCiBadge', () => {
  beforeEach(() => {
    (api.getCiRuns as any).mockReset();
  });

  it('renders nothing and does not fetch when CI on push is off', () => {
    const { container } = render(
      <DefaultBranchCiBadge projectId="p1" project={{ ciOnPush: { enabled: false } }} />,
    );
    expect(container.firstChild).toBeNull();
    expect(api.getCiRuns).not.toHaveBeenCalled();
  });

  it('shows the latest push run status and opens the runs page', async () => {
    (api.getCiRuns as any).mockResolvedValue({ runs: [pushRun] });
    const onOpenRunners = vi.fn();
    render(
      <DefaultBranchCiBadge
        projectId="p1"
        project={{ ciOnPush: { enabled: true } }}
        onOpenRunners={onOpenRunners}
      />,
    );
    expect(await screen.findByTestId('repo-default-branch-ci-label')).toHaveTextContent(
      'CI failing on main: 1 failed job',
    );
    expect(screen.getByTestId('repo-default-branch-ci')).toHaveAttribute('data-tone', 'failed');
    expect(screen.getByText('deadbeef')).toBeInTheDocument();
    expect(api.getCiRuns).toHaveBeenCalledWith('p1', { trigger: 'git_push', limit: 1 });
    fireEvent.click(screen.getByTestId('repo-default-branch-ci-open'));
    expect(onOpenRunners).toHaveBeenCalledWith('p1');
  });

  it('says no run yet when CI on push is on but nothing has run', async () => {
    (api.getCiRuns as any).mockResolvedValue({ runs: [] });
    render(<DefaultBranchCiBadge projectId="p1" project={{ ciOnPush: { enabled: true } }} />);
    expect(await screen.findByTestId('repo-default-branch-ci-label')).toHaveTextContent(
      'No CI run on the default branch yet',
    );
  });
});
