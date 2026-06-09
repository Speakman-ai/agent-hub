import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useState } from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

vi.mock('../utils/connection.js', () => ({
  getApiBase: vi.fn(() => '/api'),
  getAuthHeaders: vi.fn(() => ({})),
}));

// Stub the diff renderer — we only care that the right hunks reach it, not
// that git-diff-view paints them (its CSS/worker path is irrelevant here).
vi.mock('@git-diff-view/react', () => ({
  DiffView: ({ data }) => <div data-testid="diff-view">{data?.hunks?.[0] ?? ''}</div>,
  DiffModeEnum: { Split: 3, Unified: 4 },
}));

import SessionChangesPane from './SessionChangesPane.jsx';

const SUMMARY = {
  baseBranch: 'main',
  baseSha: 'abc123',
  headSha: 'def456',
  branch: 'agent-hub/dev/session-x',
  dirty: true,
  truncated: false,
  files: [
    {
      path: 'src/a.ts',
      status: 'modified',
      additions: 3,
      deletions: 1,
      binary: false,
      untracked: false,
    },
    {
      path: 'src/new.ts',
      status: 'added',
      additions: 5,
      deletions: 0,
      binary: false,
      untracked: true,
    },
  ],
};

const DIFF_A = {
  path: 'src/a.ts',
  status: 'modified',
  binary: false,
  unifiedDiff: 'diff --git a/src/a.ts b/src/a.ts\n@@ -1 +1 @@\n-old\n+new\n',
  tooLarge: false,
};

function mockFetch() {
  return vi.fn((url) => {
    if (url.includes('/changes/diff')) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve(DIFF_A) });
    }
    if (url.endsWith('/changes')) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve(SUMMARY) });
    }
    return Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({}) });
  });
}

beforeEach(() => {
  globalThis.fetch = mockFetch();
});
afterEach(() => {
  vi.clearAllMocks();
});

describe('SessionChangesPane', () => {
  it('renders the changed-file list with counts and lifts the summary', async () => {
    const onSummary = vi.fn();
    render(<SessionChangesPane sessionId="s1" onSummary={onSummary} />);

    await waitFor(() => expect(screen.getByText('a.ts')).toBeInTheDocument());
    expect(screen.getByText('new.ts')).toBeInTheDocument();
    // Header file count.
    expect(screen.getByText(/2 files/)).toBeInTheDocument();
    // Summary lifted to parent for the toolbar badge.
    expect(onSummary).toHaveBeenCalledWith(expect.objectContaining({ files: SUMMARY.files }));
  });

  it('auto-selects the first file and renders its diff', async () => {
    render(<SessionChangesPane sessionId="s1" />);
    await waitFor(() => expect(screen.getByTestId('diff-view')).toBeInTheDocument());
    expect(screen.getByTestId('diff-view').textContent).toContain('+new');
  });

  it('fetches the diff by file path only (server derives tracked/untracked)', async () => {
    render(<SessionChangesPane sessionId="s1" />);
    await waitFor(() => expect(screen.getByText('new.ts')).toBeInTheDocument());

    fireEvent.click(screen.getByText('new.ts'));
    await waitFor(() => {
      const diffCalls = globalThis.fetch.mock.calls
        .map((c) => c[0])
        .filter((u) => u.includes('/changes/diff'));
      // The untracked file is requested by path, with no client-supplied
      // `untracked` flag (the server is the authority on that classification).
      expect(diffCalls.some((u) => u.includes('file=src%2Fnew.ts'))).toBe(true);
      expect(diffCalls.every((u) => !u.includes('untracked'))).toBe(true);
    });
  });

  it('shows the empty state when there are no changes', async () => {
    globalThis.fetch = vi.fn(() =>
      Promise.resolve({ ok: true, json: () => Promise.resolve({ ...SUMMARY, files: [] }) }),
    );
    render(<SessionChangesPane sessionId="s1" />);
    await waitFor(() =>
      expect(screen.getByTestId('session-changes-pane-empty')).toBeInTheDocument(),
    );
  });

  it('calls onClose when the close button is clicked', async () => {
    const onClose = vi.fn();
    render(<SessionChangesPane sessionId="s1" onClose={onClose} />);
    await waitFor(() =>
      expect(screen.getByTestId('session-changes-pane-close')).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByTestId('session-changes-pane-close'));
    expect(onClose).toHaveBeenCalled();
  });

  it('does not refetch in a loop when onSummary triggers parent rerenders', async () => {
    // Reproduces the reviewer-flagged loop: the parent passes a brand-new
    // onSummary arrow every render AND rerenders whenever onSummary fires.
    // If loadSummary depended on onSummary's identity, this would refetch
    // /changes forever. The ref indirection must keep it at a single fetch.
    function Harness() {
      const [, setTick] = useState(0);
      return <SessionChangesPane sessionId="s1" onSummary={() => setTick((t) => t + 1)} />;
    }
    render(<Harness />);
    await waitFor(() => expect(screen.getByText('a.ts')).toBeInTheDocument());
    // Give any erroneous refetch loop time to run.
    await new Promise((r) => setTimeout(r, 50));
    const changesCalls = globalThis.fetch.mock.calls.filter((c) =>
      c[0].endsWith('/changes'),
    ).length;
    expect(changesCalls).toBe(1);
  });

  it('ignores a stale /changes response after sessionId changes', async () => {
    // The pane is not keyed by session in App.jsx, so a slow response for the
    // previous session must not overwrite the new session's list/badge.
    const onSummary = vi.fn();
    let resolveS1;
    globalThis.fetch = vi.fn((url) => {
      if (url.includes('/changes/diff')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve(DIFF_A) });
      }
      if (url.includes('/sessions/s1/changes')) {
        // s1 hangs until we release it — simulating a slow prior request.
        return new Promise((resolve) => {
          resolveS1 = () =>
            resolve({
              ok: true,
              json: () => Promise.resolve({ ...SUMMARY, branch: 'stale-s1' }),
            });
        });
      }
      // s2 resolves immediately.
      return Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            ...SUMMARY,
            branch: 'fresh-s2',
            files: [
              {
                path: 's2only.ts',
                status: 'modified',
                additions: 1,
                deletions: 0,
                binary: false,
                untracked: false,
              },
            ],
          }),
      });
    });

    const { rerender } = render(<SessionChangesPane sessionId="s1" onSummary={onSummary} />);
    // Switch sessions before s1 resolves.
    rerender(<SessionChangesPane sessionId="s2" onSummary={onSummary} />);
    await waitFor(() => expect(screen.getByText('s2only.ts')).toBeInTheDocument());

    // Now release the stale s1 response — it must be discarded.
    resolveS1();
    await new Promise((r) => setTimeout(r, 20));

    expect(screen.getByText('s2only.ts')).toBeInTheDocument();
    // The last summary the parent saw is s2's, never the stale s1 payload.
    expect(onSummary.mock.calls.at(-1)?.[0]?.branch).toBe('fresh-s2');
    expect(onSummary.mock.calls.some((c) => c[0]?.branch === 'stale-s1')).toBe(false);
  });

  it('discards a stale per-file diff response after switching sessions', async () => {
    // Both sessions report the SAME file path; a slow s1 diff must not land in
    // the shared cache and render for s2 (the per-file loader needs its own
    // session/reloadToken guard, not just a local cancelled flag).
    const sharedFile = {
      path: 'shared.ts',
      status: 'modified',
      additions: 1,
      deletions: 0,
      binary: false,
      untracked: false,
    };
    let resolveS1Diff;
    globalThis.fetch = vi.fn((url) => {
      if (url.includes('/sessions/s1/changes/diff')) {
        return new Promise((resolve) => {
          resolveS1Diff = () =>
            resolve({
              ok: true,
              json: () => Promise.resolve({ ...DIFF_A, unifiedDiff: 'STALE-S1-DIFF' }),
            });
        });
      }
      if (url.includes('/sessions/s2/changes/diff')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ ...DIFF_A, unifiedDiff: 'FRESH-S2-DIFF' }),
        });
      }
      if (url.endsWith('/changes')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ ...SUMMARY, files: [sharedFile] }),
        });
      }
      return Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({}) });
    });

    const { rerender } = render(<SessionChangesPane sessionId="s1" />);
    await waitFor(() => expect(screen.getByText('shared.ts')).toBeInTheDocument());
    // s1's diff is in flight (hung). Switch to s2, which resolves immediately.
    rerender(<SessionChangesPane sessionId="s2" />);
    await waitFor(() =>
      expect(screen.getByTestId('diff-view').textContent).toContain('FRESH-S2-DIFF'),
    );

    // Release the stale s1 diff — it must be discarded, not rendered for s2.
    resolveS1Diff();
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.getByTestId('diff-view').textContent).toContain('FRESH-S2-DIFF');
    expect(screen.getByTestId('diff-view').textContent).not.toContain('STALE-S1-DIFF');
  });

  it('refetches when reloadToken changes', async () => {
    const { rerender } = render(<SessionChangesPane sessionId="s1" reloadToken={0} />);
    await waitFor(() => expect(screen.getByText('a.ts')).toBeInTheDocument());
    const initialSummaryCalls = globalThis.fetch.mock.calls.filter((c) =>
      c[0].endsWith('/changes'),
    ).length;
    rerender(<SessionChangesPane sessionId="s1" reloadToken={1} />);
    await waitFor(() => {
      const after = globalThis.fetch.mock.calls.filter((c) => c[0].endsWith('/changes')).length;
      expect(after).toBeGreaterThan(initialSummaryCalls);
    });
  });
});
