import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import RepositoryPage from './RepositoryPage.jsx';
import { api } from '../utils/api.js';

vi.mock('../utils/api.js', () => ({
  api: {
    getGitHostBranches: vi.fn(),
    getGitHostCommits: vi.fn(),
    getGitHostCommitDetail: vi.fn(),
    getProjectPulls: vi.fn(),
  },
}));

const project = { id: 'proj-1', name: 'Proj One', gitHost: 'agenthub' };

const branches = {
  defaultBranch: 'main',
  branches: [
    {
      name: 'main',
      sha: 'a'.repeat(40),
      subject: 'commit two',
      author: 'Tester',
      date: '2026-06-09T00:00:00Z',
      isDefault: true,
      ahead: 0,
      behind: 0,
    },
    {
      name: 'agent-hub/dev/session-beef0001',
      sha: 'b'.repeat(40),
      subject: 'commit three',
      author: 'Tester',
      date: '2026-06-09T01:00:00Z',
      isDefault: false,
      ahead: 1,
      behind: 0,
    },
  ],
};

const mainCommits = {
  branch: 'main',
  commits: [
    { sha: 'a'.repeat(40), subject: 'commit two', author: 'Tester', date: '2026-06-09T00:00:00Z' },
    { sha: 'c'.repeat(40), subject: 'commit one', author: 'Tester', date: '2026-06-08T00:00:00Z' },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  api.getGitHostBranches.mockResolvedValue(branches);
  api.getGitHostCommits.mockResolvedValue(mainCommits);
  api.getProjectPulls.mockResolvedValue({ pulls: [{ number: 1 }, { number: 2 }] });
});

describe('RepositoryPage', () => {
  it('loads the default branch commits and shows the open-PR count', async () => {
    render(<RepositoryPage projectId="proj-1" project={project} onOpenPulls={vi.fn()} />);

    expect(await screen.findByText('commit two')).toBeInTheDocument();
    expect(screen.getByText('commit one')).toBeInTheDocument();
    expect(api.getGitHostCommits).toHaveBeenCalledWith('proj-1', { branch: 'main' });
    expect(await screen.findByText('2 open PRs')).toBeInTheDocument();
  });

  it('switches branches via the selector', async () => {
    api.getGitHostCommits.mockResolvedValueOnce(mainCommits).mockResolvedValueOnce({
      branch: 'agent-hub/dev/session-beef0001',
      commits: [
        {
          sha: 'b'.repeat(40),
          subject: 'commit three',
          author: 'Tester',
          date: '2026-06-09T01:00:00Z',
        },
      ],
    });

    render(<RepositoryPage projectId="proj-1" project={project} />);
    await screen.findByText('commit two');

    fireEvent.change(screen.getByTestId('repo-branch-select'), {
      target: { value: 'agent-hub/dev/session-beef0001' },
    });
    expect(await screen.findByText('commit three')).toBeInTheDocument();
    expect(api.getGitHostCommits).toHaveBeenLastCalledWith('proj-1', {
      branch: 'agent-hub/dev/session-beef0001',
    });
  });

  it('opens a commit page with per-file diffs, parent navigation, and back', async () => {
    api.getGitHostCommitDetail.mockImplementation((_pid, sha) =>
      Promise.resolve({
        sha,
        subject: sha === 'c'.repeat(40) ? 'commit one' : 'commit two',
        body: 'Longer body text.',
        author: 'Tester',
        date: '2026-06-09T00:00:00Z',
        parents: sha === 'c'.repeat(40) ? [] : ['c'.repeat(40)],
        stat: ' two.txt | 1 +',
        patch:
          'diff --git a/two.txt b/two.txt\n--- a/two.txt\n+++ b/two.txt\n@@ -0,0 +1 @@\n+two\n' +
          'diff --git a/other.txt b/other.txt\n--- a/other.txt\n+++ b/other.txt\n@@ -1 +0,0 @@\n-old',
        patchTruncated: false,
      }),
    );

    render(<RepositoryPage projectId="proj-1" project={project} />);
    fireEvent.click(await screen.findByTestId(`repo-commit-${'a'.repeat(8)}`));

    // Commit page renders: metadata + one section per file with counts.
    const page = await screen.findByTestId('repo-commit-page');
    expect(api.getGitHostCommitDetail).toHaveBeenCalledWith('proj-1', 'a'.repeat(40));
    expect(page).toHaveTextContent('Longer body text.');
    expect(page).toHaveTextContent('2 files');
    expect(await screen.findByTestId('commit-file-two.txt')).toHaveTextContent('+1');
    expect(screen.getByTestId('commit-file-other.txt')).toHaveTextContent('−1');
    expect(page).toHaveTextContent('+two');

    // The list (tabs, branch select) is replaced while the page is open.
    expect(screen.queryByTestId('repo-branch-select')).toBeNull();

    // Parent link navigates to the parent commit's page.
    fireEvent.click(screen.getByRole('button', { name: `parent ${'c'.repeat(8)}` }));
    await waitFor(() =>
      expect(api.getGitHostCommitDetail).toHaveBeenCalledWith('proj-1', 'c'.repeat(40)),
    );
    expect(await screen.findByText('commit one')).toBeInTheDocument();

    // Back returns to the commit list.
    fireEvent.click(screen.getByTestId('repo-commit-back'));
    expect(await screen.findByTestId('repo-branch-select')).toBeInTheDocument();
    expect(screen.queryByTestId('repo-commit-page')).toBeNull();
  });

  it('collapses a file section on click', async () => {
    api.getGitHostCommitDetail.mockResolvedValue({
      sha: 'a'.repeat(40),
      subject: 'commit two',
      body: '',
      author: 'Tester',
      date: '2026-06-09T00:00:00Z',
      parents: [],
      stat: '',
      patch: 'diff --git a/two.txt b/two.txt\n+two',
      patchTruncated: false,
    });
    render(<RepositoryPage projectId="proj-1" project={project} />);
    fireEvent.click(await screen.findByTestId(`repo-commit-${'a'.repeat(8)}`));

    const section = await screen.findByTestId('commit-file-two.txt');
    expect(screen.getByTestId('repo-commit-page')).toHaveTextContent('+two');
    fireEvent.click(section);
    expect(screen.getByTestId('repo-commit-page')).not.toHaveTextContent('+two');
  });

  it('branches tab lists ahead/behind and the default badge', async () => {
    render(<RepositoryPage projectId="proj-1" project={project} />);
    await screen.findByText('commit two');

    fireEvent.click(screen.getByRole('button', { name: /Branches/ }));
    expect(screen.getByText('agent-hub/dev/session-beef0001')).toBeInTheDocument();
    expect(screen.getByText(/1 ahead · 0 behind/)).toBeInTheDocument();
    expect(screen.getByText('default')).toBeInTheDocument();
  });

  it('shows the not-hosted hint when the endpoints 404', async () => {
    api.getGitHostBranches.mockRejectedValue(new Error('Project is not hosted on Agent Hub'));
    render(<RepositoryPage projectId="proj-1" project={project} />);
    expect(await screen.findByText(/not hosted on Agent Hub/i)).toBeInTheDocument();
  });
});
