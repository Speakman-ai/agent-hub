import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';

(vi as any).mock('../../utils/api.js', () => ({
  api: { getDefaultBranchHealth: vi.fn() },
}));

import { api } from '../../utils/api';
import { DefaultBranchHealthBanner } from './TestSelectionManifest';

const green = { state: 'green', branch: 'main', breakage: null, failures: [] };
const red = {
  state: 'red',
  branch: 'main',
  breakage: { id: 'b1', card_id: 'card-1', first_failing_sha: 'c'.repeat(40) },
  failures: [
    { job_id: 'server', matrix_key: '', first_failing_sha: 'c'.repeat(40), last_failing_sha: 'c' },
  ],
};

describe('DefaultBranchHealthBanner refresh', () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.useRealTimers());

  it('turns red when a push-CI run settles, without remounting', async () => {
    (api.getDefaultBranchHealth as any).mockResolvedValue(green);
    const { rerender } = render(
      <DefaultBranchHealthBanner projectId="p1" refreshKey="r1:running" pollMs={0} />,
    );
    await waitFor(() => expect(api.getDefaultBranchHealth).toHaveBeenCalledTimes(1));
    expect(screen.queryByTestId('default-branch-red-banner')).not.toBeInTheDocument();

    (api.getDefaultBranchHealth as any).mockResolvedValue(red);
    rerender(<DefaultBranchHealthBanner projectId="p1" refreshKey="r1:failed" pollMs={0} />);
    expect(await screen.findByTestId('default-branch-red-banner')).toHaveTextContent(
      'main is red: 1 failing instance',
    );
  });

  it('clears the banner on the next poll once the branch is green again', async () => {
    vi.useFakeTimers();
    (api.getDefaultBranchHealth as any).mockResolvedValue(red);
    render(<DefaultBranchHealthBanner projectId="p1" pollMs={1000} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.getByTestId('default-branch-red-banner')).toBeInTheDocument();

    (api.getDefaultBranchHealth as any).mockResolvedValue(green);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(screen.queryByTestId('default-branch-red-banner')).not.toBeInTheDocument();
    expect(screen.queryByTestId('default-branch-breakage-card')).not.toBeInTheDocument();
  });

  it('keeps the last known state when a refresh fails', async () => {
    vi.useFakeTimers();
    (api.getDefaultBranchHealth as any).mockResolvedValue(red);
    render(<DefaultBranchHealthBanner projectId="p1" pollMs={1000} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    (api.getDefaultBranchHealth as any).mockRejectedValue(new Error('offline'));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(screen.getByTestId('default-branch-red-banner')).toBeInTheDocument();
  });

  it('drops the previous project red banner when the new project read fails', async () => {
    (api.getDefaultBranchHealth as any).mockImplementation((id: string) =>
      id === 'p1' ? Promise.resolve(red) : Promise.reject(new Error('offline')),
    );
    const { rerender } = render(<DefaultBranchHealthBanner projectId="p1" pollMs={0} />);
    expect(await screen.findByTestId('default-branch-breakage-card')).toHaveAttribute(
      'href',
      '/projects/p1/board?card=card-1',
    );

    rerender(<DefaultBranchHealthBanner projectId="p2" pollMs={0} />);
    expect(screen.queryByTestId('default-branch-red-banner')).not.toBeInTheDocument();
    await waitFor(() => expect(api.getDefaultBranchHealth).toHaveBeenCalledWith('p2'));
    await act(async () => {});
    expect(screen.queryByTestId('default-branch-red-banner')).not.toBeInTheDocument();
    expect(screen.queryByTestId('default-branch-breakage-card')).not.toBeInTheDocument();
  });

  it('ignores a slow response for the project the view already left', async () => {
    let resolveP1!: (v: unknown) => void;
    (api.getDefaultBranchHealth as any).mockImplementation((id: string) =>
      id === 'p1' ? new Promise((r) => (resolveP1 = r)) : Promise.resolve(green),
    );
    const { rerender } = render(<DefaultBranchHealthBanner projectId="p1" pollMs={0} />);
    await waitFor(() => expect(resolveP1).toBeTypeOf('function'));
    rerender(<DefaultBranchHealthBanner projectId="p2" pollMs={0} />);
    await act(async () => {
      resolveP1(red);
    });
    expect(screen.queryByTestId('default-branch-red-banner')).not.toBeInTheDocument();
  });
});
