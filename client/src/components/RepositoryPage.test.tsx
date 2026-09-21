import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import RepositoryPage from './RepositoryPage';
import { api } from '../utils/api';

(vi as any).mock('../utils/api.js', () => ({
  api: {
    getGitHostBranches: vi.fn(),
    getGitHostCommits: vi.fn(),
    getGitHostCommitDetail: vi.fn(),
    getGitHostTree: vi.fn(),
    getGitHostFile: vi.fn(),
    getGitHostPaths: vi.fn(),
    getGitHostReadme: vi.fn(),
    getGitHostStatus: vi.fn(),
    getGitHostMirror: vi.fn(),
    getProjectPulls: vi.fn(),
    deleteGitHostBranch: vi.fn(),
  },
}));

const project = {
  id: 'proj-1',
  name: 'Proj One',
  gitHost: 'agenthub',
  githubRepo: 'acme/webapp',
};

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

const mainTree = {
  branch: 'main',
  path: '',
  commitCount: 2,
  latestCommit: {
    sha: 'a'.repeat(40),
    subject: 'commit two',
    author: 'Tester',
    date: '2026-06-09T00:00:00Z',
  },
  entries: [
    {
      name: 'src',
      path: 'src',
      type: 'tree',
      size: null,
      mode: '040000',
      lastCommit: {
        sha: 'a'.repeat(40),
        subject: 'commit two',
        author: 'Tester',
        date: '2026-06-09T00:00:00Z',
      },
    },
    {
      name: 'README.md',
      path: 'README.md',
      type: 'blob',
      size: 12,
      mode: '100644',
      lastCommit: {
        sha: 'c'.repeat(40),
        subject: 'commit one',
        author: 'Tester',
        date: '2026-06-08T00:00:00Z',
      },
    },
  ],
};

const featureTree = {
  branch: 'agent-hub/dev/session-beef0001',
  path: '',
  commitCount: 3,
  latestCommit: {
    sha: 'b'.repeat(40),
    subject: 'commit three',
    author: 'Tester',
    date: '2026-06-09T01:00:00Z',
  },
  entries: [
    {
      name: 'three.txt',
      path: 'three.txt',
      type: 'blob',
      size: 6,
      mode: '100644',
      lastCommit: {
        sha: 'b'.repeat(40),
        subject: 'commit three',
        author: 'Tester',
        date: '2026-06-09T01:00:00Z',
      },
    },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  (api.getGitHostBranches as any).mockResolvedValue(branches);
  (api.getGitHostCommits as any).mockResolvedValue(mainCommits);
  (api.getGitHostTree as any).mockResolvedValue(mainTree);
  (api.getGitHostReadme as any).mockResolvedValue({
    readme: {
      path: 'README.md',
      content: '# Hello',
      truncated: false,
      branch: 'main',
      mediaToken: 't',
    },
  });
  (api.getGitHostStatus as any).mockResolvedValue({ cloneUrl: 'http://hub/git/proj-1.git' });
  (api.getGitHostMirror as any).mockRejectedValue(new Error('not hosted'));
  (api.getGitHostPaths as any).mockResolvedValue({
    branch: 'main',
    paths: ['README.md', 'src/app.ts'],
  });
  (api.getProjectPulls as any).mockResolvedValue({ pulls: [{ number: 1 }, { number: 2 }] });
});

describe('RepositoryPage', () => {
  it('loads the default branch file tree, README, and open-PR count', async () => {
    render(<RepositoryPage projectId="proj-1" project={project} onOpenPulls={vi.fn()} />);

    expect(await screen.findByTestId('repo-file-tree')).toBeInTheDocument();
    expect(screen.getByTestId('repo-entry-src')).toHaveTextContent('src');
    expect(screen.getByTestId('repo-entry-README.md')).toHaveTextContent('README.md');
    expect(api.getGitHostTree).toHaveBeenCalledWith('proj-1', { branch: 'main', path: '' });
    expect(await screen.findByTestId('repo-open-pr-count')).toHaveTextContent('2');
    expect(screen.getByTestId('repo-readme-content')).toHaveTextContent('Hello');
    expect(screen.getByText('acme')).toBeInTheDocument();
    expect(screen.getByText('webapp')).toBeInTheDocument();
  });

  it('switches branches via the picker', async () => {
    (api.getGitHostTree as any).mockResolvedValueOnce(mainTree).mockResolvedValueOnce(featureTree);

    render(<RepositoryPage projectId="proj-1" project={project} />);
    await screen.findByTestId('repo-entry-README.md');

    fireEvent.click(screen.getByTestId('repo-branch-select' as any));
    fireEvent.click(screen.getByRole('button', { name: /agent-hub\/dev\/session-beef0001/ }));
    expect(await screen.findByTestId('repo-entry-three.txt')).toBeInTheDocument();
    expect(api.getGitHostTree).toHaveBeenLastCalledWith('proj-1', {
      branch: 'agent-hub/dev/session-beef0001',
      path: '',
    });
  });

  it('opens a file blob from the tree', async () => {
    (api.getGitHostFile as any).mockResolvedValue({
      path: 'README.md',
      branch: 'main',
      content: '# Hello blob\n',
      binary: false,
      truncated: false,
      size: 13,
    });
    render(<RepositoryPage projectId="proj-1" project={project} />);
    fireEvent.click(await screen.findByTestId('repo-entry-README.md'));
    expect(await screen.findByTestId('repo-file-page')).toHaveTextContent('Hello blob');
    expect(api.getGitHostFile).toHaveBeenCalledWith('proj-1', {
      branch: 'main',
      path: 'README.md',
    });
  });

  it('opens a commit page with per-file diffs, parent navigation, and back', async () => {
    (api.getGitHostCommitDetail as any).mockImplementation((_pid: any, sha: any) =>
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
    fireEvent.click(await screen.findByTestId('repo-commits-link' as any));
    fireEvent.click(await screen.findByTestId(`repo-commit-${'a'.repeat(8 as any)}`));

    const page = await screen.findByTestId('repo-commit-page');
    expect(api.getGitHostCommitDetail).toHaveBeenCalledWith('proj-1', 'a'.repeat(40));
    expect(page!).toHaveTextContent('Longer body text.');
    expect(page!).toHaveTextContent('2 files');
    expect(await screen.findByTestId('commit-file-two.txt')).toHaveTextContent('+1');
    expect(screen.getByTestId('commit-file-other.txt')).toHaveTextContent('−1');
    expect(page!).toHaveTextContent('+two');

    expect(screen.queryByTestId('repo-branch-select')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: `parent ${'c'.repeat(8 as any)}` }));
    await waitFor(() =>
      expect(api.getGitHostCommitDetail).toHaveBeenCalledWith('proj-1', 'c'.repeat(40)),
    );
    expect(await screen.findByText('commit one')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('repo-commit-back' as any) as any);
    expect(await screen.findByTestId('repo-commit-list')).toBeInTheDocument();
    expect(await screen.findByTestId('repo-branch-select')).toBeInTheDocument();
    expect(screen.queryByTestId('repo-commit-page')).toBeNull();
  });

  it('collapses a file section on click', async () => {
    (api.getGitHostCommitDetail as any).mockResolvedValue({
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
    fireEvent.click(await screen.findByTestId('repo-commits-link' as any));
    fireEvent.click(await screen.findByTestId(`repo-commit-${'a'.repeat(8 as any)}`));

    const section = await screen.findByTestId('commit-file-two.txt');
    expect(screen.getByTestId('repo-commit-page')).toHaveTextContent('+two');
    fireEvent.click(section as any);
    expect(screen.getByTestId('repo-commit-page')).not.toHaveTextContent('+two');
  });

  it('branches list shows ahead/behind and the default badge', async () => {
    render(<RepositoryPage projectId="proj-1" project={project} />);
    await screen.findByTestId('repo-entry-README.md');

    fireEvent.click(screen.getByTestId('repo-branch-select' as any));
    fireEvent.click(screen.getByRole('button', { name: /View all branches/ }));
    expect(screen.getByText('agent-hub/dev/session-beef0001')).toBeInTheDocument();
    expect(screen.getByText(/1 ahead · 0 behind/)).toBeInTheDocument();
    expect(screen.getByText('default')).toBeInTheDocument();
  });

  it('Code tab returns to the file tree from History and from the branch list', async () => {
    render(<RepositoryPage projectId="proj-1" project={project} />);
    await screen.findByTestId('repo-entry-README.md');

    // History -> Code
    fireEvent.click(screen.getByTestId('repo-commits-link'));
    expect(await screen.findByTestId('repo-commit-list')).toBeInTheDocument();
    const codeTab = screen.getByTestId('repo-tab-code');
    expect(codeTab).not.toBeDisabled();
    fireEvent.click(codeTab);
    expect(await screen.findByTestId('repo-file-tree')).toBeInTheDocument();
    expect(screen.queryByTestId('repo-commit-list')).toBeNull();

    // Branches -> Code
    fireEvent.click(screen.getByTestId('repo-branch-select'));
    fireEvent.click(screen.getByRole('button', { name: /View all branches/ }));
    expect(await screen.findByTestId('repo-branch-list')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('repo-tab-code'));
    expect(await screen.findByTestId('repo-file-tree')).toBeInTheDocument();
    expect(screen.queryByTestId('repo-branch-list')).toBeNull();

    // Blob -> Code
    (api.getGitHostFile as any).mockResolvedValue({
      branch: 'main',
      path: 'README.md',
      content: '# Hello',
      binary: false,
      truncated: false,
      size: 7,
    });
    fireEvent.click(screen.getByTestId('repo-entry-README.md'));
    await waitFor(() => expect(api.getGitHostFile).toHaveBeenCalled());
    fireEvent.click(screen.getByTestId('repo-tab-code'));
    expect(await screen.findByTestId('repo-file-tree')).toBeInTheDocument();
  });

  it('does not reuse the previous project paths/commits after a project switch', async () => {
    const projectTwo = { ...project, id: 'proj-2', name: 'Proj Two' };
    const { rerender } = render(<RepositoryPage projectId="proj-1" project={project} />);
    await screen.findByTestId('repo-entry-README.md');

    // Populate both project-scoped caches for proj-1.
    fireEvent.click(screen.getByTestId('repo-go-to-file'));
    expect(await screen.findByText('src/app.ts')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('repo-go-to-file-close'));
    fireEvent.click(screen.getByTestId('repo-commits-link'));
    await screen.findByTestId('repo-commit-list');
    fireEvent.click(screen.getByTestId('repo-tab-code'));
    await screen.findByTestId('repo-file-tree');

    (api.getGitHostPaths as any).mockResolvedValue({ branch: 'main', paths: ['only-in-two.ts'] });
    (api.getGitHostCommits as any).mockResolvedValue({
      branch: 'main',
      commits: [
        { sha: 'd'.repeat(40), subject: 'two only', author: 'T', date: '2026-06-10T00:00:00Z' },
      ],
    });

    rerender(<RepositoryPage projectId="proj-2" project={projectTwo} />);
    await screen.findByTestId('repo-entry-README.md');

    fireEvent.click(screen.getByTestId('repo-go-to-file'));
    expect(await screen.findByText('only-in-two.ts')).toBeInTheDocument();
    expect(screen.queryByText('src/app.ts')).toBeNull();
    expect(api.getGitHostPaths).toHaveBeenLastCalledWith('proj-2', { branch: 'main' });
    fireEvent.click(screen.getByTestId('repo-go-to-file-close'));

    fireEvent.click(screen.getByTestId('repo-commits-link'));
    expect(await screen.findByText('two only')).toBeInTheDocument();
    expect(screen.queryByText('commit one')).toBeNull();
  });

  it('ignores a tree response that a newer branch switch superseded', async () => {
    let releaseMain: (v: any) => void = () => {};
    const slowMain = new Promise((resolve) => {
      releaseMain = resolve;
    });
    (api.getGitHostTree as any)
      .mockResolvedValueOnce(mainTree) // initial load
      .mockImplementationOnce(() => slowMain) // branch A: slow
      .mockResolvedValueOnce(featureTree); // branch B: fast

    render(<RepositoryPage projectId="proj-1" project={project} />);
    await screen.findByTestId('repo-entry-README.md');

    // Switch to A (hangs), then immediately to B (resolves).
    fireEvent.click(screen.getByTestId('repo-branch-select'));
    fireEvent.click(screen.getByRole('button', { name: /agent-hub\/dev\/session-beef0001/ }));
    fireEvent.click(screen.getByTestId('repo-branch-select'));
    fireEvent.click(screen.getByRole('button', { name: /^main \(default\)$/ }));
    expect(await screen.findByTestId('repo-entry-three.txt')).toBeInTheDocument();

    // A's late response must not repaint the tree B already rendered.
    releaseMain(mainTree);
    await waitFor(() => expect(screen.getByTestId('repo-entry-three.txt')).toBeInTheDocument());
    expect(screen.queryByTestId('repo-entry-README.md')).toBeNull();
  });

  it('does not leave the old tree clickable when a branch request fails', async () => {
    (api.getGitHostTree as any)
      .mockResolvedValueOnce(mainTree)
      .mockRejectedValueOnce(new Error('branch blew up'));

    render(<RepositoryPage projectId="proj-1" project={project} onToast={vi.fn()} />);
    await screen.findByTestId('repo-entry-README.md');

    fireEvent.click(screen.getByTestId('repo-branch-select'));
    fireEvent.click(screen.getByRole('button', { name: /agent-hub\/dev\/session-beef0001/ }));

    // The failed navigation already moved selectedBranch; main's rows must not
    // still be sitting there, or clicking one fetches it from the wrong branch.
    expect(await screen.findByTestId('repo-tree-error')).toHaveTextContent('branch blew up');
    expect(screen.queryByTestId('repo-entry-README.md')).toBeNull();
    expect(screen.queryByTestId('repo-entry-src')).toBeNull();
    expect(screen.queryByText('This directory is empty.')).toBeNull();

    // The tree error offers its own direct recovery.
    (api.getGitHostTree as any).mockResolvedValue(featureTree);
    fireEvent.click(screen.getByTestId('repo-tree-retry'));
    expect(await screen.findByTestId('repo-entry-three.txt')).toBeInTheDocument();
    expect(screen.queryByTestId('repo-tree-error')).toBeNull();
  });

  it('does not leave the old tree clickable when a directory request fails', async () => {
    (api.getGitHostTree as any)
      .mockResolvedValueOnce(mainTree)
      .mockRejectedValueOnce(new Error('dir blew up'));

    render(<RepositoryPage projectId="proj-1" project={project} onToast={vi.fn()} />);
    await screen.findByTestId('repo-entry-src');

    fireEvent.click(screen.getByTestId('repo-entry-src'));

    expect(await screen.findByTestId('repo-tree-error')).toHaveTextContent('dir blew up');
    expect(screen.queryByTestId('repo-entry-README.md')).toBeNull();
  });

  it('drops a refresh whose branches resolved after the project switched', async () => {
    const projectTwo = { ...project, id: 'proj-2', name: 'Proj Two' };
    const twoTree = { ...featureTree, branch: 'main' };

    let releaseOne: (v: any) => void = () => {};
    (api.getGitHostBranches as any)
      // proj-1's branch load hangs past the project switch.
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            releaseOne = resolve;
          }),
      )
      .mockResolvedValue(branches);
    (api.getGitHostTree as any).mockResolvedValue(twoTree);

    const { rerender } = render(<RepositoryPage projectId="proj-1" project={project} />);
    rerender(<RepositoryPage projectId="proj-2" project={projectTwo} />);
    expect(await screen.findByTestId('repo-entry-three.txt')).toBeInTheDocument();

    const treeCallsBefore = (api.getGitHostTree as any).mock.calls.length;
    // proj-1's branches finally land. They must not set selectedBranch or start
    // a tree request — that request would win a fresh generation and repaint
    // proj-2's tree with proj-1 data.
    await act(async () => {
      releaseOne(branches);
      await Promise.resolve();
      await Promise.resolve();
    });

    await waitFor(() => expect(screen.getByTestId('repo-entry-three.txt')).toBeInTheDocument());
    expect((api.getGitHostTree as any).mock.calls.length).toBe(treeCallsBefore);
    expect((api.getGitHostTree as any).mock.calls.every((c: any[]) => c[0] === 'proj-2')).toBe(
      true,
    );
  });

  it('keeps the open-PR count from a previous project off the new one', async () => {
    const projectTwo = { ...project, id: 'proj-2', name: 'Proj Two' };
    let releaseOne: (v: any) => void = () => {};
    (api.getProjectPulls as any)
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            releaseOne = resolve;
          }),
      )
      .mockResolvedValue({ pulls: [{ number: 9 }] });

    const { rerender } = render(<RepositoryPage projectId="proj-1" project={project} />);
    rerender(<RepositoryPage projectId="proj-2" project={projectTwo} />);
    expect(await screen.findByTestId('repo-open-pr-count')).toHaveTextContent('1');

    // proj-1's count (3 PRs) lands late and must be ignored.
    await act(async () => {
      releaseOne({ pulls: [{ number: 1 }, { number: 2 }, { number: 3 }] });
      await Promise.resolve();
    });
    expect(screen.getByTestId('repo-open-pr-count')).toHaveTextContent('1');
  });

  it('a delete finishing after a project switch cannot reload the old branches', async () => {
    const projectTwo = { ...project, id: 'proj-2', name: 'Proj Two' };
    let releaseDelete: (v: any) => void = () => {};
    (api.deleteGitHostBranch as any).mockImplementation(
      () =>
        new Promise((resolve) => {
          releaseDelete = resolve;
        }),
    );

    const { rerender } = render(
      <RepositoryPage projectId="proj-1" project={project} onToast={vi.fn()} />,
    );
    await screen.findByTestId('repo-entry-README.md');
    fireEvent.click(screen.getByTestId('repo-branch-select'));
    fireEvent.click(screen.getByRole('button', { name: /View all branches/ }));

    const del = await screen.findByTestId('delete-branch-agent-hub/dev/session-beef0001');
    fireEvent.click(del); // arm confirmation
    fireEvent.click(del); // fires the delete, which hangs

    rerender(<RepositoryPage projectId="proj-2" project={projectTwo} />);
    await screen.findByTestId('repo-entry-README.md');

    const callsBefore = (api.getGitHostBranches as any).mock.calls.length;
    await act(async () => {
      releaseDelete({});
      await Promise.resolve();
      await Promise.resolve();
    });

    // The continuation belongs to proj-1. Starting a fresh loadBranches here
    // would win a new generation and overwrite proj-2's branchData.
    expect((api.getGitHostBranches as any).mock.calls.length).toBe(callsBefore);
  });

  it('Refresh invalidates the History and Go-to-file caches', async () => {
    render(<RepositoryPage projectId="proj-1" project={project} onToast={vi.fn()} />);
    await screen.findByTestId('repo-entry-README.md');

    // Populate both caches on this branch.
    fireEvent.click(screen.getByTestId('repo-go-to-file'));
    await screen.findByText('src/app.ts');
    fireEvent.click(screen.getByTestId('repo-go-to-file-close'));
    fireEvent.click(screen.getByTestId('repo-commits-link'));
    await screen.findByTestId('repo-commit-list');
    fireEvent.click(screen.getByTestId('repo-tab-code'));
    await screen.findByTestId('repo-file-tree');

    const pathCallsBefore = (api.getGitHostPaths as any).mock.calls.length;
    const commitCallsBefore = (api.getGitHostCommits as any).mock.calls.length;

    // A new commit lands on the same branch; Refresh must not leave History and
    // Go to file serving their pre-refresh caches.
    (api.getGitHostPaths as any).mockResolvedValue({
      branch: 'main',
      paths: ['README.md', 'src/app.ts', 'brand-new.ts'],
    });
    (api.getGitHostCommits as any).mockResolvedValue({
      branch: 'main',
      commits: [
        {
          sha: 'e'.repeat(40),
          subject: 'brand new commit',
          author: 'T',
          date: '2026-06-11T00:00:00Z',
        },
      ],
    });

    fireEvent.click(screen.getByTestId('repo-refresh'));
    await waitFor(() => expect((api.getGitHostTree as any).mock.calls.length).toBeGreaterThan(0));

    fireEvent.click(screen.getByTestId('repo-go-to-file'));
    expect(await screen.findByText('brand-new.ts')).toBeInTheDocument();
    expect((api.getGitHostPaths as any).mock.calls.length).toBeGreaterThan(pathCallsBefore);
    fireEvent.click(screen.getByTestId('repo-go-to-file-close'));

    fireEvent.click(screen.getByTestId('repo-commits-link'));
    expect(await screen.findByText('brand new commit')).toBeInTheDocument();
    expect((api.getGitHostCommits as any).mock.calls.length).toBeGreaterThan(commitCallsBefore);
  });

  it('a superseded branch selection cannot overwrite the newer branch history', async () => {
    // History view, so handleBranchChange takes its loadCommits continuation.
    let releaseTreeA: (v: any) => void = () => {};
    (api.getGitHostTree as any)
      .mockResolvedValueOnce(mainTree) // initial
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            releaseTreeA = resolve;
          }),
      ) // branch A: slow
      .mockResolvedValue(mainTree); // branch B: fast

    (api.getGitHostCommits as any).mockImplementation(async (_id: any, { branch }: any) =>
      branch === 'main'
        ? mainCommits
        : {
            branch,
            commits: [
              {
                sha: 'f'.repeat(40),
                subject: 'A-only commit',
                author: 'T',
                date: '2026-06-12T00:00:00Z',
              },
            ],
          },
    );

    render(<RepositoryPage projectId="proj-1" project={project} onToast={vi.fn()} />);
    await screen.findByTestId('repo-entry-README.md');
    fireEvent.click(screen.getByTestId('repo-commits-link'));
    await screen.findByTestId('repo-commit-list');

    // Select A (tree hangs), then B (completes) from the History branch picker.
    fireEvent.click(screen.getByTestId('repo-branch-select'));
    fireEvent.click(screen.getByRole('button', { name: /agent-hub\/dev\/session-beef0001/ }));
    fireEvent.click(screen.getByTestId('repo-branch-select'));
    fireEvent.click(screen.getByRole('button', { name: /^main \(default\)$/ }));
    expect(await screen.findByText('commit two')).toBeInTheDocument();

    // A's tree now resolves. loadTree discards the response but RETURNS
    // normally, so the continuation runs — it must not start loadCommits for A
    // and blank out B's history.
    await act(async () => {
      releaseTreeA(featureTree);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.queryByText('A-only commit')).toBeNull();
    expect(screen.getByText('commit two')).toBeInTheDocument();
  });

  it('resolves relative images in a nested Markdown blob against the repo', async () => {
    const nestedTree = {
      ...mainTree,
      entries: [{ ...mainTree.entries[1], name: 'guide.md', path: 'docs/guide.md' }],
    };
    (api.getGitHostTree as any).mockResolvedValue(nestedTree);
    (api.getGitHostFile as any).mockResolvedValue({
      branch: 'main',
      path: 'docs/guide.md',
      content: '# Guide\n\n![shot](shot.png)\n',
      binary: false,
      truncated: false,
      size: 30,
      mediaToken: 'tok-123',
    });

    render(<RepositoryPage projectId="proj-1" project={project} />);
    fireEvent.click(await screen.findByTestId('repo-entry-docs/guide.md'));

    const md = await screen.findByTestId('repo-blob-markdown');
    const img = md.querySelector('img');
    expect(img).not.toBeNull();
    const src = img!.getAttribute('src') || '';
    // Resolved against the repo media mount, relative to the FILE's directory —
    // not left as a bare 'shot.png' that the SPA would resolve against its URL.
    expect(src).not.toBe('shot.png');
    expect(src).toContain('git-host-media/proj-1');
    // Resolved relative to docs/, not the repo root.
    expect(decodeURIComponent(src)).toContain('path=docs/shot.png');
    expect(src).toContain('tok-123');
  });

  it('a paths response in flight during Refresh cannot repopulate the cache', async () => {
    let releaseStalePaths: (v: any) => void = () => {};
    (api.getGitHostPaths as any)
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            releaseStalePaths = resolve;
          }),
      )
      .mockResolvedValue({ branch: 'main', paths: ['fresh-after-refresh.ts'] });

    render(<RepositoryPage projectId="proj-1" project={project} onToast={vi.fn()} />);
    await screen.findByTestId('repo-entry-README.md');

    // Open Go to file (request hangs), then close it while still pending.
    fireEvent.click(screen.getByTestId('repo-go-to-file'));
    await screen.findByTestId('repo-go-to-file-modal');
    fireEvent.click(screen.getByTestId('repo-go-to-file-close'));

    fireEvent.click(screen.getByTestId('repo-refresh'));
    await waitFor(() => expect(api.getGitHostBranches).toHaveBeenCalled());

    // The pre-refresh response lands now. Clearing the cache without bumping
    // its generation would let this repopulate it under the same key, and the
    // next open would read it as a valid hit and skip fetching.
    await act(async () => {
      releaseStalePaths({ branch: 'main', paths: ['stale-before-refresh.ts'] });
      await Promise.resolve();
      await Promise.resolve();
    });

    fireEvent.click(screen.getByTestId('repo-go-to-file'));
    expect(await screen.findByText('fresh-after-refresh.ts')).toBeInTheDocument();
    expect(screen.queryByText('stale-before-refresh.ts')).toBeNull();
  });

  it('offers a working Retry after a failed refresh', async () => {
    (api.getGitHostBranches as any)
      .mockRejectedValueOnce(new Error('transient boom'))
      .mockResolvedValue(branches);

    render(<RepositoryPage projectId="proj-1" project={project} onToast={vi.fn()} />);

    // codeBody() (which owns the normal Refresh button) is suppressed while the
    // page-level error is set, so this control is the only way back.
    expect(await screen.findByTestId('repo-error')).toHaveTextContent('transient boom');
    expect(screen.queryByTestId('repo-refresh')).toBeNull();

    fireEvent.click(screen.getByTestId('repo-error-retry'));

    expect(await screen.findByTestId('repo-file-tree')).toBeInTheDocument();
    expect(screen.getByTestId('repo-entry-README.md')).toBeInTheDocument();
    expect(screen.queryByTestId('repo-error')).toBeNull();
  });

  it('clears armed and in-flight branch deletion state across a project switch', async () => {
    const projectTwo = { ...project, id: 'proj-2', name: 'Proj Two' };
    const victim = 'agent-hub/dev/session-beef0001';
    let releaseDelete: (v: any) => void = () => {};
    (api.deleteGitHostBranch as any).mockImplementation(
      () =>
        new Promise((resolve) => {
          releaseDelete = resolve;
        }),
    );

    const { rerender } = render(
      <RepositoryPage projectId="proj-1" project={project} onToast={vi.fn()} />,
    );
    await screen.findByTestId('repo-entry-README.md');
    fireEvent.click(screen.getByTestId('repo-branch-select'));
    fireEvent.click(screen.getByRole('button', { name: /View all branches/ }));

    const del = await screen.findByTestId(`delete-branch-${victim}`);
    fireEvent.click(del); // arm the confirmation
    expect(screen.getByTestId(`delete-branch-${victim}`)).toHaveTextContent('Delete branch?');
    fireEvent.click(screen.getByTestId(`delete-branch-${victim}`)); // fires; hangs
    await waitFor(() => expect(screen.getByTestId(`delete-branch-${victim}`)).toBeDisabled());

    rerender(<RepositoryPage projectId="proj-2" project={projectTwo} />);
    await screen.findByTestId('repo-entry-README.md');
    fireEvent.click(screen.getByTestId('repo-branch-select'));
    fireEvent.click(screen.getByRole('button', { name: /View all branches/ }));

    const delTwo = await screen.findByTestId(`delete-branch-${victim}`);
    // The superseded delete's guarded `finally` never runs, so without an
    // explicit reset this same-named branch stays permanently disabled...
    expect(delTwo).not.toBeDisabled();
    // ...and the armed confirmation would carry over, deleting proj-2's branch
    // on the very first click.
    expect(delTwo).not.toHaveTextContent('Delete branch?');
    expect(api.deleteGitHostBranch).toHaveBeenCalledTimes(1);

    // The old delete landing later must not resurrect any of that state.
    await act(async () => {
      releaseDelete({});
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getByTestId(`delete-branch-${victim}`)).not.toBeDisabled();
  });

  it('Retry after a failed switch uses the new project default, not the old selection', async () => {
    const projectTwo = { ...project, id: 'proj-2', name: 'Proj Two' };
    // proj-2 does NOT have proj-1's feature branch.
    const branchesTwo = {
      defaultBranch: 'main',
      branches: [{ ...branches.branches[0] }],
    };
    (api.getGitHostBranches as any).mockImplementation(async (id: string) =>
      id === 'proj-1' ? branches : branchesTwo,
    );

    const { rerender } = render(
      <RepositoryPage projectId="proj-1" project={project} onToast={vi.fn()} />,
    );
    await screen.findByTestId('repo-entry-README.md');

    // Select proj-1's feature branch.
    (api.getGitHostTree as any).mockResolvedValue(featureTree);
    fireEvent.click(screen.getByTestId('repo-branch-select'));
    fireEvent.click(screen.getByRole('button', { name: /agent-hub\/dev\/session-beef0001/ }));
    await screen.findByTestId('repo-entry-three.txt');

    // Switch to proj-2, whose first branches request fails transiently.
    (api.getGitHostBranches as any).mockRejectedValueOnce(new Error('transient boom'));
    rerender(<RepositoryPage projectId="proj-2" project={projectTwo} />);
    expect(await screen.findByTestId('repo-error')).toHaveTextContent('transient boom');

    (api.getGitHostTree as any).mockResolvedValue(mainTree);
    (api.getGitHostTree as any).mockClear();
    fireEvent.click(screen.getByTestId('repo-error-retry'));

    // Retry must target proj-2's default branch. Carrying proj-1's selection
    // would make refresh prefer a branch proj-2 lacks, so every retry fails
    // with "Tree not found" long after the transient error cleared.
    expect(await screen.findByTestId('repo-entry-README.md')).toBeInTheDocument();
    const branchArgs = (api.getGitHostTree as any).mock.calls.map((c: any[]) => c[1]?.branch);
    expect(branchArgs).not.toContain('agent-hub/dev/session-beef0001');
    expect(branchArgs.every((b: any) => b === 'main' || b === undefined)).toBe(true);
  });

  it('a deferred history response for another branch cannot blank the displayed one', async () => {
    const featureBranch = 'agent-hub/dev/session-beef0001';
    const featureCommits = {
      branch: featureBranch,
      commits: [
        {
          sha: 'f'.repeat(40),
          subject: 'feature commit',
          author: 'T',
          date: '2026-06-12T00:00:00Z',
        },
      ],
    };
    let releaseFeatureCommits: () => void = () => {};
    (api.getGitHostCommits as any).mockImplementation(async (_id: any, { branch }: any) => {
      if (branch === featureBranch) {
        return new Promise((resolve) => {
          releaseFeatureCommits = () => resolve(featureCommits);
        });
      }
      return mainCommits;
    });

    render(<RepositoryPage projectId="proj-1" project={project} onToast={vi.fn()} />);
    await screen.findByTestId('repo-entry-README.md');

    // 1. Cache main's history, then return to Code.
    fireEvent.click(screen.getByTestId('repo-commits-link'));
    expect(await screen.findByText('commit two')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('repo-tab-code'));
    await screen.findByTestId('repo-file-tree');

    // 2. Switch to the feature branch and open History — request left pending.
    fireEvent.click(screen.getByTestId('repo-branch-select'));
    fireEvent.click(screen.getByRole('button', { name: new RegExp(featureBranch) }));
    fireEvent.click(await screen.findByTestId('repo-commits-link'));
    fireEvent.click(screen.getByTestId('repo-tab-code'));
    await screen.findByTestId('repo-file-tree');

    // 3. Back to main and reopen History — served from cache, so NO new
    //    commits request is issued and no generation is bumped.
    fireEvent.click(screen.getByTestId('repo-branch-select'));
    fireEvent.click(screen.getByRole('button', { name: /^main \(default\)$/ }));
    fireEvent.click(await screen.findByTestId('repo-commits-link'));
    expect(await screen.findByText('commit two')).toBeInTheDocument();

    // 4. The feature branch's response finally lands. A single-slot cache would
    //    be overwritten with a feature-keyed entry, so main's derived commits
    //    becomes null and the history the user is looking at goes blank.
    await act(async () => {
      releaseFeatureCommits();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.getByText('commit two')).toBeInTheDocument();
    expect(screen.queryByText('feature commit')).toBeNull();
  });

  it('an empty repository still reaches the clone URL', async () => {
    // Unborn repo: initialized, never pushed to — no branch ref at all.
    (api.getGitHostBranches as any).mockResolvedValue({ defaultBranch: null, branches: [] });
    (api.getGitHostTree as any).mockRejectedValue(new Error('Tree not found'));
    (api.getGitHostStatus as any).mockResolvedValue({ cloneUrl: 'http://hub/git/proj-1.git' });

    render(<RepositoryPage projectId="proj-1" project={project} onToast={vi.fn()} />);

    // Must present as an empty repo, not a page-level error that hides the
    // clone controls the user needs to push a first commit.
    expect(await screen.findByTestId('repo-empty')).toBeInTheDocument();
    expect(screen.getByTestId('repo-empty-clone-url')).toHaveTextContent(
      'http://hub/git/proj-1.git',
    );
    expect(screen.queryByTestId('repo-error')).toBeNull();
    // The tree endpoint must not even be consulted for an unborn repo.
    expect(api.getGitHostTree).not.toHaveBeenCalled();
  });

  it('a tree failure keeps the clone menu and branch picker reachable', async () => {
    // Branches load fine; only the tree fails. Taking the whole page into the
    // error state would hide codeBody, and with it the clone controls.
    (api.getGitHostTree as any).mockRejectedValue(new Error('Tree not found'));

    render(<RepositoryPage projectId="proj-1" project={project} onToast={vi.fn()} />);

    expect(await screen.findByTestId('repo-tree-error')).toHaveTextContent('Tree not found');
    expect(screen.queryByTestId('repo-error')).toBeNull();
    expect(screen.getByTestId('repo-branch-select')).toBeInTheDocument();
    expect(screen.getByTestId('repo-refresh')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('repo-code-menu'));
    expect(await screen.findByText('http://hub/git/proj-1.git')).toBeInTheDocument();
  });

  it('at cache capacity, a deferred response cannot evict the displayed history', async () => {
    // 10 branches so the 8-entry cache is driven past capacity.
    const many = Array.from({ length: 10 }, (_, i) => ({
      name: `br-${i}`,
      sha: String(i).repeat(40),
      subject: `subject ${i}`,
      author: 'T',
      date: '2026-06-09T00:00:00Z',
      isDefault: i === 0,
      ahead: 0,
      behind: 0,
    }));
    (api.getGitHostBranches as any).mockResolvedValue({
      defaultBranch: 'br-0',
      branches: many,
    });

    let releaseNinth: (() => void) | null = null;
    (api.getGitHostCommits as any).mockImplementation(async (_id: any, { branch }: any) => {
      if (branch === 'br-9') {
        return new Promise((resolve) => {
          releaseNinth = () =>
            resolve({
              branch: 'br-9',
              commits: [
                {
                  sha: '9'.repeat(40),
                  subject: 'ninth commit',
                  author: 'T',
                  date: '2026-06-12T00:00:00Z',
                },
              ],
            });
        });
      }
      return {
        branch,
        commits: [
          {
            sha: 'a'.repeat(40),
            subject: `commit for ${branch}`,
            author: 'T',
            date: '2026-06-09T00:00:00Z',
          },
        ],
      };
    });

    render(<RepositoryPage projectId="proj-1" project={project} onToast={vi.fn()} />);
    await screen.findByTestId('repo-entry-README.md');

    // Fill the cache: br-0 (the displayed one) is inserted FIRST, so it is the
    // oldest entry and the first eviction candidate.
    for (let i = 0; i < 8; i += 1) {
      if (i > 0) {
        fireEvent.click(screen.getByTestId('repo-branch-select'));
        fireEvent.click(screen.getByRole('button', { name: new RegExp(`^br-${i}`) }));
      }
      fireEvent.click(await screen.findByTestId('repo-commits-link'));
      expect(await screen.findByText(`commit for br-${i}`)).toBeInTheDocument();
      fireEvent.click(screen.getByTestId('repo-tab-code'));
      await screen.findByTestId('repo-file-tree');
    }

    // Start a deferred History request for a 9th branch.
    fireEvent.click(screen.getByTestId('repo-branch-select'));
    fireEvent.click(screen.getByRole('button', { name: /^br-9/ }));
    fireEvent.click(await screen.findByTestId('repo-commits-link'));
    fireEvent.click(screen.getByTestId('repo-tab-code'));
    await screen.findByTestId('repo-file-tree');

    // Return to br-0 and reopen its CACHED history — no new request, so nothing
    // bumps the generation.
    fireEvent.click(screen.getByTestId('repo-branch-select'));
    fireEvent.click(screen.getByRole('button', { name: /^br-0/ }));
    fireEvent.click(await screen.findByTestId('repo-commits-link'));
    expect(await screen.findByText('commit for br-0')).toBeInTheDocument();

    const callsForBrZeroBefore = (api.getGitHostCommits as any).mock.calls.filter(
      (c: any[]) => c[1]?.branch === 'br-0',
    ).length;

    // br-9 resolves and pushes the cache over capacity. Insertion-order
    // eviction would delete br-0 — the entry on screen — blanking it.
    await act(async () => {
      releaseNinth?.();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(await screen.findByText('commit for br-0')).toBeInTheDocument();
    expect(screen.queryByText('ninth commit')).toBeNull();
    // Distinguishes "never evicted" from "evicted, then silently refetched":
    // the self-heal effect would also restore the text, so assert that the
    // displayed entry survived and no reload for br-0 was needed.
    const brZeroCalls = (api.getGitHostCommits as any).mock.calls.filter(
      (c: any[]) => c[1]?.branch === 'br-0',
    ).length;
    expect(brZeroCalls).toBe(callsForBrZeroBefore);
  });

  it('reloads an active scope that is missing instead of rendering blank', async () => {
    (api.getGitHostCommits as any).mockResolvedValue(mainCommits);

    render(<RepositoryPage projectId="proj-1" project={project} onToast={vi.fn()} />);
    await screen.findByTestId('repo-entry-README.md');

    fireEvent.click(screen.getByTestId('repo-commits-link'));
    expect(await screen.findByText('commit two')).toBeInTheDocument();
    const before = (api.getGitHostCommits as any).mock.calls.length;

    // Refresh drops every cached scope while History is still on screen. The
    // active scope is now absent, and must reload rather than stay blank.
    fireEvent.click(screen.getByTestId('repo-tab-code'));
    await screen.findByTestId('repo-file-tree');
    fireEvent.click(screen.getByTestId('repo-refresh'));
    fireEvent.click(await screen.findByTestId('repo-commits-link'));

    expect(await screen.findByText('commit two')).toBeInTheDocument();
    await waitFor(() =>
      expect((api.getGitHostCommits as any).mock.calls.length).toBeGreaterThan(before),
    );
  });

  it('a deferred paths rejection for branch A never surfaces on branch B', async () => {
    const featureBranch = 'agent-hub/dev/session-beef0001';
    let rejectA: ((e: any) => void) | null = null;
    (api.getGitHostPaths as any).mockImplementation(async (_id: any, { branch }: any) => {
      if (branch === 'main') {
        return new Promise((_resolve, reject) => {
          rejectA = reject;
        });
      }
      return { branch, paths: ['only-on-feature.ts'] };
    });

    render(<RepositoryPage projectId="proj-1" project={project} onToast={vi.fn()} />);
    await screen.findByTestId('repo-entry-README.md');

    // Open Go to file on main; its request hangs. Close it.
    fireEvent.click(screen.getByTestId('repo-go-to-file'));
    await screen.findByTestId('repo-go-to-file-modal');
    fireEvent.click(screen.getByTestId('repo-go-to-file-close'));

    // Switch to an uncached branch and reopen. main's pending flag must not
    // block this request.
    fireEvent.click(screen.getByTestId('repo-branch-select'));
    fireEvent.click(screen.getByRole('button', { name: new RegExp(featureBranch) }));
    fireEvent.click(await screen.findByTestId('repo-go-to-file'));
    expect(await screen.findByText('only-on-feature.ts')).toBeInTheDocument();

    // main's request now rejects. Its generation is still current, so a global
    // error would render here — on a branch that loaded perfectly well.
    await act(async () => {
      rejectA?.(new Error('branch A paths blew up'));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.queryByTestId('repo-paths-error')).toBeNull();
    expect(screen.getByText('only-on-feature.ts')).toBeInTheDocument();
  });

  it('a deferred history rejection for branch A never surfaces on branch B', async () => {
    const featureBranch = 'agent-hub/dev/session-beef0001';
    let rejectA: ((e: any) => void) | null = null;
    (api.getGitHostCommits as any).mockImplementation(async (_id: any, { branch }: any) => {
      if (branch === 'main') {
        return new Promise((_resolve, reject) => {
          rejectA = reject;
        });
      }
      return {
        branch,
        commits: [
          {
            sha: 'f'.repeat(40),
            subject: 'feature commit',
            author: 'T',
            date: '2026-06-12T00:00:00Z',
          },
        ],
      };
    });

    render(<RepositoryPage projectId="proj-1" project={project} onToast={vi.fn()} />);
    await screen.findByTestId('repo-entry-README.md');

    // Leave a pending History for main, return to Code, then switch branches.
    fireEvent.click(screen.getByTestId('repo-commits-link'));
    await screen.findByTestId('repo-commit-list');
    fireEvent.click(screen.getByTestId('repo-tab-code'));
    await screen.findByTestId('repo-file-tree');

    fireEvent.click(screen.getByTestId('repo-branch-select'));
    fireEvent.click(screen.getByRole('button', { name: new RegExp(featureBranch) }));
    fireEvent.click(await screen.findByTestId('repo-commits-link'));
    expect(await screen.findByText('feature commit')).toBeInTheDocument();

    await act(async () => {
      rejectA?.(new Error('branch A history blew up'));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.queryByTestId('repo-commits-error')).toBeNull();
    expect(screen.getByText('feature commit')).toBeInTheDocument();
  });

  it('returning to branch A after B loaded shows A, not a stuck spinner', async () => {
    const featureBranch = 'agent-hub/dev/session-beef0001';
    let releaseMain: (() => void) | null = null;
    (api.getGitHostPaths as any).mockImplementation(async (_id: any, { branch }: any) => {
      if (branch === 'main') {
        return new Promise((resolve) => {
          releaseMain = () => resolve({ branch: 'main', paths: ['main-only.ts'] });
        });
      }
      return { branch, paths: ['feature-only.ts'] };
    });

    render(<RepositoryPage projectId="proj-1" project={project} onToast={vi.fn()} />);
    await screen.findByTestId('repo-entry-README.md');

    // Start main's paths request, then leave it pending.
    fireEvent.click(screen.getByTestId('repo-go-to-file'));
    await screen.findByTestId('repo-go-to-file-modal');
    fireEvent.click(screen.getByTestId('repo-go-to-file-close'));

    // Load another branch. A shared generation would treat this as superseding
    // main's request, so main's response would be discarded WITHOUT clearing
    // main's pending flag.
    fireEvent.click(screen.getByTestId('repo-branch-select'));
    fireEvent.click(screen.getByRole('button', { name: new RegExp(featureBranch) }));
    fireEvent.click(await screen.findByTestId('repo-go-to-file'));
    expect(await screen.findByText('feature-only.ts')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('repo-go-to-file-close'));

    // main's response settles its OWN entry.
    await act(async () => {
      releaseMain?.();
      await Promise.resolve();
      await Promise.resolve();
    });

    // Back on main, Go to file must show main's paths rather than hanging on
    // an orphaned pending entry with no error and therefore no Retry.
    fireEvent.click(screen.getByTestId('repo-branch-select'));
    fireEvent.click(screen.getByRole('button', { name: /^main \(default\)$/ }));
    fireEvent.click(await screen.findByTestId('repo-go-to-file'));

    expect(await screen.findByText('main-only.ts')).toBeInTheDocument();
    expect(screen.queryByText(/Loading paths/i)).toBeNull();
  });

  it('returning to branch A history after B loaded shows A, not a stuck spinner', async () => {
    const featureBranch = 'agent-hub/dev/session-beef0001';
    let releaseMain: (() => void) | null = null;
    (api.getGitHostCommits as any).mockImplementation(async (_id: any, { branch }: any) => {
      if (branch === 'main') {
        return new Promise((resolve) => {
          releaseMain = () => resolve(mainCommits);
        });
      }
      return {
        branch,
        commits: [
          {
            sha: 'f'.repeat(40),
            subject: 'feature commit',
            author: 'T',
            date: '2026-06-12T00:00:00Z',
          },
        ],
      };
    });

    render(<RepositoryPage projectId="proj-1" project={project} onToast={vi.fn()} />);
    await screen.findByTestId('repo-entry-README.md');

    // Leave main's History pending, navigate through Code to another branch.
    fireEvent.click(screen.getByTestId('repo-commits-link'));
    await screen.findByTestId('repo-commit-list');
    fireEvent.click(screen.getByTestId('repo-tab-code'));
    await screen.findByTestId('repo-file-tree');

    fireEvent.click(screen.getByTestId('repo-branch-select'));
    fireEvent.click(screen.getByRole('button', { name: new RegExp(featureBranch) }));
    fireEvent.click(await screen.findByTestId('repo-commits-link'));
    expect(await screen.findByText('feature commit')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('repo-tab-code'));
    await screen.findByTestId('repo-file-tree');

    await act(async () => {
      releaseMain?.();
      await Promise.resolve();
      await Promise.resolve();
    });

    fireEvent.click(screen.getByTestId('repo-branch-select'));
    fireEvent.click(screen.getByRole('button', { name: /^main \(default\)$/ }));
    fireEvent.click(await screen.findByTestId('repo-commits-link'));

    expect(await screen.findByText('commit two')).toBeInTheDocument();
    expect(screen.queryByText(/Loading history/i)).toBeNull();
  });

  it('renders a submodule as an inert gitlink entry', async () => {
    (api.getGitHostTree as any).mockResolvedValue({
      ...mainTree,
      entries: [
        {
          name: 'dep',
          path: 'vendor/dep',
          type: 'commit',
          size: null,
          mode: '160000',
          lastCommit: {
            sha: 'd'.repeat(40),
            subject: 'add submodule',
            author: 'Tester',
            date: '2026-06-09T00:00:00Z',
          },
        },
      ],
    });

    render(<RepositoryPage projectId="proj-1" project={project} onToast={vi.fn()} />);

    const entry = await screen.findByTestId('repo-entry-vendor/dep');
    // Visible and labelled — a directory of submodules used to render empty.
    expect(entry).toHaveTextContent('dep');
    expect(screen.getByTestId('repo-submodule-vendor/dep')).toBeInTheDocument();
    expect(screen.queryByText('This directory is empty.')).toBeNull();

    // Inert: no tree to browse and no blob to read on this side.
    expect(entry).toBeDisabled();
    fireEvent.click(entry);
    expect(api.getGitHostFile).not.toHaveBeenCalled();
    expect(api.getGitHostTree).toHaveBeenCalledTimes(1);
  });

  it('Retry works after a failed reload of an already cached scope', async () => {
    const featureBranch = 'agent-hub/dev/session-beef0001';
    const reloaded = {
      branch: 'main',
      commits: [
        {
          sha: 'e'.repeat(40),
          subject: 'reloaded commit',
          author: 'T',
          date: '2026-06-13T00:00:00Z',
        },
      ],
    };
    let mainCalls = 0;
    (api.getGitHostCommits as any).mockImplementation(async (_id: any, { branch }: any) => {
      if (branch !== 'main') {
        return {
          branch,
          commits: [
            {
              sha: 'f'.repeat(40),
              subject: 'feature commit',
              author: 'T',
              date: '2026-06-12T00:00:00Z',
            },
          ],
        };
      }
      mainCalls += 1;
      if (mainCalls === 1) return mainCommits; // first load: cached
      if (mainCalls === 2) throw new Error('reload blew up'); // switching back
      return reloaded; // the retry
    });

    render(<RepositoryPage projectId="proj-1" project={project} onToast={vi.fn()} />);
    await screen.findByTestId('repo-entry-README.md');

    // 1. Cache main's history.
    fireEvent.click(screen.getByTestId('repo-commits-link'));
    expect(await screen.findByText('commit two')).toBeInTheDocument();

    // 2. Switch away and back — handleBranchChange reloads main unconditionally.
    fireEvent.click(screen.getByTestId('repo-branch-select'));
    fireEvent.click(screen.getByRole('button', { name: new RegExp(featureBranch) }));
    expect(await screen.findByText('feature commit')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('repo-branch-select'));
    fireEvent.click(screen.getByRole('button', { name: /^main \(default\)$/ }));

    // 3. The reload failed, but main's cached data is still present — which is
    //    exactly what made the self-heal effect decline to refetch.
    expect(await screen.findByTestId('repo-commits-error')).toHaveTextContent('reload blew up');
    const before = mainCalls;

    // 4. Retry must actually issue a request, not just clear the error.
    fireEvent.click(screen.getByTestId('repo-commits-retry'));
    expect(await screen.findByText('reloaded commit')).toBeInTheDocument();
    expect(mainCalls).toBeGreaterThan(before);
    expect(screen.queryByTestId('repo-commits-error')).toBeNull();
  });

  it('shows the not-hosted hint when the endpoints 404', async () => {
    (api.getGitHostBranches as any).mockRejectedValue(
      new Error('Project is not hosted on Agent Hub'),
    );
    render(<RepositoryPage projectId="proj-1" project={project} />);
    expect(await screen.findByText(/not hosted on Agent Hub/i)).toBeInTheDocument();
  });
});
