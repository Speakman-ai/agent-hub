import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import type { KanbanCardRow } from './types.js';

// `autonomous.ts` calls `promisify(exec)` at module load via auto-git.ts.
// Preserve real exports and only stub the methods this test inspects.
vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return {
    ...actual,
    execFile: vi.fn(),
  };
});

vi.mock('./routes/board.js', () => ({
  getOrCreateBoard: vi.fn(),
}));

// Stub the webhook module so our test never reaches the real reviewer
// dispatch path (which would try to spawn the reviewer agent).
const mockDispatchReviewerForPR = vi.fn();
const mockIsReviewerDispatchPending = vi.fn();
const mockDispatchReviewFeedback = vi.fn();

vi.mock('./routes/webhooks.js', () => ({
  notifyDispatchFailure: vi.fn(),
  dispatchReviewFeedback: (...args: unknown[]) => mockDispatchReviewFeedback(...args),
  dispatchReviewerForPR: (...args: unknown[]) => mockDispatchReviewerForPR(...args),
  isReviewerDispatchPending: (...args: unknown[]) => mockIsReviewerDispatchPending(...args),
}));

const { getOrCreateBoard } = await import('./routes/board.js');
const mockGetOrCreateBoard = getOrCreateBoard as Mock;

const { initAutonomous, pollForLanModeReviewerDispatch } = await import('./autonomous.js');
const { execFile: execFileImport } = await import('child_process');

beforeEach(() => {
  vi.mocked(execFileImport).mockReset();
  mockGetOrCreateBoard.mockReset();
  mockDispatchReviewerForPR.mockReset().mockReturnValue(true);
  mockIsReviewerDispatchPending.mockReset().mockReturnValue(false);
  mockDispatchReviewFeedback.mockReset();
});

interface CardOverride {
  review_status?: KanbanCardRow['review_status'];
  last_dispatched_review_id?: number | null;
  pr_url?: string | null;
}

function makeDeps(overrides: {
  reviewCardIds?: string[];
  cardOverrides?: Record<string, CardOverride>;
  setCardLastDispatchedReviewIdRun?: Mock;
  /** Toggle LAN mode in the returned getConfig dep. Default true (test the on-path). */
  lanMode?: boolean;
  /** Whether the project has a reviewer agent. Default true. */
  withReviewer?: boolean;
}): Parameters<typeof initAutonomous>[0] {
  const reviewId = 'col-review';
  const setCardLastDispatchedReviewIdRun = overrides.setCardLastDispatchedReviewIdRun || vi.fn();
  const stmts = {
    getKanbanColumns: {
      all: vi.fn(() => [
        { id: reviewId, name: 'Review' },
        { id: 'col-progress', name: 'In Progress' },
      ]),
    },
    getKanbanCardsByColumn: {
      all: vi.fn((colId: string) => {
        const cards: KanbanCardRow[] = [];
        for (const id of overrides.reviewCardIds || []) {
          if (colId === reviewId) {
            const extra = overrides.cardOverrides?.[id] ?? {};
            cards.push({
              id,
              column_id: reviewId,
              title: `Card ${id}`,
              pr_url: extra.pr_url === undefined ? 'https://github.com/o/r/pull/99' : extra.pr_url,
              review_status: extra.review_status ?? null,
              last_dispatched_review_id: extra.last_dispatched_review_id ?? null,
              last_dispatched_check_run_id: null,
              last_dispatched_review_comment_id: null,
            } as KanbanCardRow);
          }
        }
        return cards;
      }),
    },
    setCardLastDispatchedReviewId: { run: setCardLastDispatchedReviewIdRun },
    // `isReviewerDispatchPending` checks this — we stub the entire function
    // above, but defense-in-depth keep the stmt present so cardless paths
    // don't crash.
    hasDeferredPendingForPrKey: { get: vi.fn(() => undefined) },
  };
  const reviewerAgent = { id: 'reviewer-1', role: 'reviewer' };
  const project = {
    id: 'p1',
    name: 'P',
    cwd: '/tmp',
    ahw: '',
    agents: overrides.withReviewer === false ? [] : [reviewerAgent],
  };
  return {
    stmts: stmts as never,
    broadcast: vi.fn(),
    findProject: vi.fn(() => project as never),
    findAgent: vi.fn(() => null),
    handleChat: vi.fn(),
    handleCancel: vi.fn(),
    getActiveProcesses: vi.fn(() => new Map()),
    getProjects: vi.fn(() => [project] as never),
    getConfig: vi.fn(() => ({ lanMode: overrides.lanMode ?? true }) as never),
    getGhAuthenticatedUser: vi.fn(() => 'human'),
    getGhBotUser: vi.fn(() => null),
    getGhAppSlug: vi.fn(() => null),
    getWebhookHandlerDeps: vi.fn(
      () =>
        ({
          stmts,
          findAgent: vi.fn(),
          handleChat: vi.fn(),
          broadcast: vi.fn(),
        }) as never,
    ),
    getDb: vi.fn(
      () =>
        ({
          transaction: (fn: (...args: unknown[]) => unknown) => {
            const wrap = ((...args: unknown[]) => fn(...args)) as unknown as Record<
              string,
              unknown
            >;
            wrap.immediate = (...args: unknown[]) => fn(...args);
            wrap.deferred = (...args: unknown[]) => fn(...args);
            wrap.exclusive = (...args: unknown[]) => fn(...args);
            return wrap;
          },
        }) as never,
    ),
  };
}

describe('pollForLanModeReviewerDispatch', () => {
  it('no-ops when LAN mode is off (webhook path is canonical)', async () => {
    mockGetOrCreateBoard.mockReturnValue({ board: { id: 'b1' } });
    initAutonomous(makeDeps({ reviewCardIds: ['c1'], lanMode: false }) as never);

    await pollForLanModeReviewerDispatch();

    expect(mockDispatchReviewerForPR).not.toHaveBeenCalled();
    expect(vi.mocked(execFileImport)).not.toHaveBeenCalled();
  });

  it('dispatches reviewer for a Review card with PR URL and no prior dispatch', async () => {
    mockGetOrCreateBoard.mockReturnValue({ board: { id: 'b1' } });
    vi.mocked(execFileImport).mockImplementation(((
      _cmd: string,
      args: readonly string[] | null | undefined,
      _opts: unknown,
      cb: (err: Error | null, stdout: string, stderr: string) => void,
    ) => {
      const argv = args ?? [];
      if (argv[0] === 'api' && String(argv[1]).endsWith('/pulls/99')) {
        cb(null, JSON.stringify({ title: 'Fix the foo', state: 'open', head_sha: 'abc123' }), '');
      } else {
        cb(new Error('unexpected'), '', '');
      }
      return undefined as never;
    }) as unknown as typeof execFileImport);

    const setCardRun = vi.fn();
    initAutonomous(
      makeDeps({
        reviewCardIds: ['c-fresh'],
        setCardLastDispatchedReviewIdRun: setCardRun,
      }) as never,
    );

    await pollForLanModeReviewerDispatch();

    expect(mockDispatchReviewerForPR).toHaveBeenCalledTimes(1);
    const [, , opts] = mockDispatchReviewerForPR.mock.calls[0];
    expect(opts).toMatchObject({
      prNumber: 99,
      prTitle: 'Fix the foo',
      repoFullName: 'o/r',
      reason: 'opened',
      headSha: 'abc123',
    });
    // Sentinel marker persisted so the next tick doesn't refire.
    expect(setCardRun).toHaveBeenCalledWith(0, 'c-fresh');
  });

  it('skips cards that already have last_dispatched_review_id set', async () => {
    mockGetOrCreateBoard.mockReturnValue({ board: { id: 'b1' } });
    initAutonomous(
      makeDeps({
        reviewCardIds: ['c-already'],
        cardOverrides: { 'c-already': { last_dispatched_review_id: 42 } },
      }) as never,
    );

    await pollForLanModeReviewerDispatch();

    expect(mockDispatchReviewerForPR).not.toHaveBeenCalled();
    expect(vi.mocked(execFileImport)).not.toHaveBeenCalled();
  });

  it('skips approved cards', async () => {
    mockGetOrCreateBoard.mockReturnValue({ board: { id: 'b1' } });
    initAutonomous(
      makeDeps({
        reviewCardIds: ['c-approved'],
        cardOverrides: { 'c-approved': { review_status: 'approved' } },
      }) as never,
    );

    await pollForLanModeReviewerDispatch();

    expect(mockDispatchReviewerForPR).not.toHaveBeenCalled();
  });

  it('skips when isReviewerDispatchPending returns true (debounce in flight)', async () => {
    mockGetOrCreateBoard.mockReturnValue({ board: { id: 'b1' } });
    mockIsReviewerDispatchPending.mockReturnValue(true);

    initAutonomous(makeDeps({ reviewCardIds: ['c-pending'] }) as never);

    await pollForLanModeReviewerDispatch();

    expect(mockDispatchReviewerForPR).not.toHaveBeenCalled();
    // PR-info fetch is the step *after* the pending check, so it must not run either.
    expect(vi.mocked(execFileImport)).not.toHaveBeenCalled();
  });

  it('skips closed PRs returned by gh api', async () => {
    mockGetOrCreateBoard.mockReturnValue({ board: { id: 'b1' } });
    vi.mocked(execFileImport).mockImplementation(((
      _cmd: string,
      args: readonly string[] | null | undefined,
      _opts: unknown,
      cb: (err: Error | null, stdout: string, stderr: string) => void,
    ) => {
      const argv = args ?? [];
      if (argv[0] === 'api' && String(argv[1]).endsWith('/pulls/99')) {
        cb(null, JSON.stringify({ title: 'Old PR', state: 'closed', head_sha: 'deadbeef' }), '');
      } else {
        cb(new Error('unexpected'), '', '');
      }
      return undefined as never;
    }) as unknown as typeof execFileImport);

    initAutonomous(makeDeps({ reviewCardIds: ['c-closed'] }) as never);

    await pollForLanModeReviewerDispatch();

    expect(mockDispatchReviewerForPR).not.toHaveBeenCalled();
  });

  it('skips projects without a reviewer agent', async () => {
    mockGetOrCreateBoard.mockReturnValue({ board: { id: 'b1' } });
    initAutonomous(makeDeps({ reviewCardIds: ['c-noreviewer'], withReviewer: false }) as never);

    await pollForLanModeReviewerDispatch();

    expect(mockDispatchReviewerForPR).not.toHaveBeenCalled();
  });

  it('skips cards with no pr_url', async () => {
    mockGetOrCreateBoard.mockReturnValue({ board: { id: 'b1' } });
    initAutonomous(
      makeDeps({
        reviewCardIds: ['c-no-pr'],
        cardOverrides: { 'c-no-pr': { pr_url: null } },
      }) as never,
    );

    await pollForLanModeReviewerDispatch();

    expect(mockDispatchReviewerForPR).not.toHaveBeenCalled();
  });
});
