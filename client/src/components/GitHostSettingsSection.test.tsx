import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import GitHostSettingsSection from './GitHostSettingsSection';
import { api } from '../utils/api';

(vi as any).mock('../utils/api.js', () => ({
  api: {
    getGitHostStatus: vi.fn(),
    enableGitHost: vi.fn(),
    disableGitHost: vi.fn(),
    getGitHostBranches: vi.fn(async () => ({ defaultBranch: 'main', branches: [] })),
    setGitHostDefaultBranch: vi.fn(),
    updateProject: vi.fn(),
  },
}));

const project = { id: 'proj-1', name: 'Proj One' };

const disabledStatus = {
  enabled: false,
  cloneUrl: null,
  defaultBranch: null,
  branchCount: 0,
  importState: null,
  mirror: null,
};

const enabledStatus = {
  enabled: true,
  cloneUrl: 'http://127.0.0.1:3051/git/proj-1.git',
  defaultBranch: 'main',
  branchCount: 1,
  importState: { status: 'ready', startedAt: 1, finishedAt: 2, importedFrom: 'cwd' },
  mirror: { enabled: true, refs: 'default-branch' },
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('GitHostSettingsSection', () => {
  it('renders nothing when the status endpoint is unavailable (older server)', async () => {
    (api.getGitHostStatus as any).mockRejectedValue(new Error('404'));
    const { container } = render(<GitHostSettingsSection project={project} />);
    await waitFor(() => expect(api.getGitHostStatus).toHaveBeenCalledWith('proj-1'));
    expect(container!.querySelector('[data-testid="project-git-host-proj-1"]')).toBeNull();
  });

  it('renders the toggle off with no clone URL when hosting is disabled', async () => {
    (api.getGitHostStatus as any).mockResolvedValue(disabledStatus);
    render(<GitHostSettingsSection project={project} />);
    expect(await screen.findByText('Git hosting')).toBeInTheDocument();
    expect(screen.queryByTestId('project-git-host-clone-url-proj-1')).toBeNull();
  });

  it('enable: calls the endpoint, shows import progress, then the clone URL + mirror state', async () => {
    (api.getGitHostStatus as any)
      .mockResolvedValueOnce(disabledStatus) // initial load
      .mockResolvedValueOnce({
        ...disabledStatus,
        importState: { status: 'importing', startedAt: 1 },
      }) // refresh right after enable
      .mockResolvedValue(enabledStatus); // poll settles
    (api.enableGitHost as any).mockResolvedValue({ importState: { status: 'importing' } });
    const showToast = vi.fn();

    render(<GitHostSettingsSection project={project} showToast={showToast} />);
    fireEvent.click(await screen.findByTestId('project-git-host-toggle-proj-1' as any));

    await waitFor(() => expect(api.enableGitHost).toHaveBeenCalledWith('proj-1'));
    expect(await screen.findByText(/Importing repository/i)).toBeInTheDocument();

    // Poll (1.5s interval) flips to ready → clone URL renders + success toast.
    await waitFor(
      () =>
        expect(screen.getByTestId('project-git-host-clone-url-proj-1')).toHaveTextContent(
          'http://127.0.0.1:3051/git/proj-1.git',
        ),
      { timeout: 5000 },
    );
    expect(screen.getByText(/Mirroring the default branch to GitHub/i)).toBeInTheDocument();
    await waitFor(() =>
      expect(showToast!).toHaveBeenCalledWith('Agent Hub git hosting enabled', 'success'),
    );
  });

  it('disable: calls the endpoint and reports via toast', async () => {
    (api.getGitHostStatus as any)
      .mockResolvedValueOnce(enabledStatus)
      .mockResolvedValue(disabledStatus);
    (api.disableGitHost as any).mockResolvedValue(disabledStatus);
    const showToast = vi.fn();

    render(<GitHostSettingsSection project={project} showToast={showToast} />);
    fireEvent.click(await screen.findByTestId('project-git-host-toggle-proj-1' as any));

    await waitFor(() => expect(api.disableGitHost).toHaveBeenCalledWith('proj-1'));
    await waitFor(() =>
      expect(showToast!).toHaveBeenCalledWith(expect.stringMatching(/disabled/i), 'success'),
    );
  });

  it('surfaces an import failure from the poll', async () => {
    (api.getGitHostStatus as any)
      .mockResolvedValueOnce(disabledStatus)
      .mockResolvedValueOnce({
        ...disabledStatus,
        importState: { status: 'importing', startedAt: 1 },
      })
      .mockResolvedValue({
        ...disabledStatus,
        importState: { status: 'error', startedAt: 1, error: 'clone failed' },
      });
    (api.enableGitHost as any).mockResolvedValue({});
    const showToast = vi.fn();

    render(<GitHostSettingsSection project={project} showToast={showToast} />);
    fireEvent.click(await screen.findByTestId('project-git-host-toggle-proj-1' as any));

    expect(
      await screen.findByText(/Import failed: clone failed/i, undefined, { timeout: 5000 }),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(showToast!).toHaveBeenCalledWith(expect.stringMatching(/clone failed/), 'error'),
    );
  });
});
