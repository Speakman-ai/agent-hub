import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import type { KanbanCardRow } from './types.js';

// `autonomous.ts` now (transitively, via the per-user GitHub credential
// helpers in `auto-git.ts`) calls `promisify(exec)` at module load. A bare
// `{ execFile: vi.fn() }` mock leaves `exec` undefined and load fails. We
// preserve the original module's other exports via `importOriginal` and
// only stub the methods the tests actually inspect.
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

const mockDispatchReviewFeedback = vi.fn().mockResolvedValue({
  sessionId: 'sess-1',
  userMessagePersisted: true,
});

vi.mock('./routes/webhooks.js', () => ({
  notifyDispatchFailure: vi.fn(),
  dispatchReviewFeedback: (...args: unknown[]) => mockDispatchReviewFeedback(...args),
}));

const { getOrCreateBoard } = await import('./routes/board.js');
const mockGetOrCreateBoard = getOrCreateBoard as Mock;

const { initAutonomous, pollForMissedReviews, lastDispatchedReviewId } =
  await import('./autonomous.js');
const { execFile: execFileImport } = await import('child_process');

beforeEach(() => {
  vi.mocked(execFileImport).mockReset();
  mockGetOrCreateBoard.mockReset();
  mockDispatchReviewFeedback.mockClear();
  mockDispatchReviewFeedback.mockResolvedValue({
    sessionId: 'sess-1',
    userMessagePersisted: true,
  });
  lastDispatchedReviewId.clear();
});

interface CardOverride {
  review_status?: KanbanCardRow['review_status'];
  last_dispatched_review_id?: number | null;
  last_dispatched_check_run_id?: number | null;
  last_dispatched_review_comment_id?: number | null;
}

function makeDeps(overrides: {
  reviewCardIds?: string[];
  inProgressCardIds?: string[];
  moveKanbanCardRun?: Mock;
  setCardLastDispatchedReviewId?: Mock;
  setCardLastDispatchedCheckRunId?: Mock;
  setCardLastDispatchedReviewCommentId?: Mock;
  getGhBotUser?: Mock;
  /** Per-card property overrides keyed by card id. */
  cardOverrides?: Record<string, CardOverride>;
}): Parameters<typeof initAutonomous>[0] {
  const reviewId = 'col-review';
  const inProgressId = 'col-progress';
  const setCardLastDispatchedReviewIdRun = overrides.setCardLastDispatchedReviewId || vi.fn();
  const setCardLastDispatchedCheckRunIdRun = overrides.setCardLastDispatchedCheckRunId || vi.fn();
  const setCardLastDispatchedReviewCommentIdRun =
    overrides.setCardLastDispatchedReviewCommentId || vi.fn();
  const stmts = {
    getKanbanColumns: {
      all: vi.fn(() => [
        { id: reviewId, name: 'Review' },
        { id: inProgressId, name: 'In Progress' },
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
              pr_url: 'https://github.com/o/r/pull/99',
              review_status: extra.review_status ?? null,
              last_dispatched_review_id: extra.last_dispatched_review_id ?? null,
              last_dispatched_check_run_id: extra.last_dispatched_check_run_id ?? null,
              last_dispatched_review_comment_id: extra.last_dispatched_review_comment_id ?? null,
            } as KanbanCardRow);
          }
        }
        for (const id of overrides.inProgressCardIds || []) {
          if (colId === inProgressId) {
            const extra = overrides.cardOverrides?.[id] ?? {};
            cards.push({
              id,
              column_id: inProgressId,
              title: `Card ${id}`,
              pr_url: 'https://github.com/o/r/pull/99',
              review_status: extra.review_status ?? null,
              last_dispatched_review_id: extra.last_dispatched_review_id ?? null,
              last_dispatched_check_run_id: extra.last_dispatched_check_run_id ?? null,
              last_dispatched_review_comment_id: extra.last_dispatched_review_comment_id ?? null,
            } as KanbanCardRow);
          }
        }
        return cards;
      }),
    },
    moveKanbanCard: { run: overrides.moveKanbanCardRun || vi.fn() },
    setCardLastDispatchedReviewId: { run: setCardLastDispatchedReviewIdRun },
    setCardLastDispatchedCheckRunId: { run: setCardLastDispatchedCheckRunIdRun },
    setCardLastDispatchedReviewCommentId: { run: setCardLastDispatchedReviewCommentIdRun },
  };
  return {
    stmts: stmts as never,
    broadcast: vi.fn(),
    findProject: vi.fn(() => ({ id: 'p1', name: 'P', cwd: '/tmp', ahw: '', agents: [] }) as never),
    findAgent: vi.fn(() => null),
    handleChat: vi.fn(),
    handleCancel: vi.fn(),
    getActiveProcesses: vi.fn(() => new Map()),
    getProjects: vi.fn(() => [{ id: 'p1', name: 'P', cwd: '/tmp', ahw: '', agents: [] }] as never),
    getConfig: vi.fn(() => ({}) as never),
    getGhAuthenticatedUser: vi.fn(() => 'human'),
    getGhBotUser: overrides.getGhBotUser || vi.fn(() => null),
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
    // `pollForMissedReviews` doesn't exercise the slot-claim transaction, but
    // the dep is required by the interface — provide a minimal stand-in.
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

describe('pollForMissedReviews', () => {
  it('scans In Progress as well as Review for pending CHANGES_REQUESTED', async () => {
    mockGetOrCreateBoard.mockReturnValue({ board: { id: 'b1' } });
    vi.mocked(execFileImport).mockImplementation(((
      _cmd: string,
      args: readonly string[] | null | undefined,
      _opts: unknown,
      cb: (err: Error | null, stdout: string, stderr: string) => void,
    ) => {
      const argv = args ?? [];
      if (argv[0] === 'api' && String(argv[1]).includes('/pulls/99/reviews')) {
        cb(null, JSON.stringify([{ id: 5001, submitted_at: '2026-05-01' }]), '');
      } else {
        cb(new Error('unexpected'), '', '');
      }
      return undefined as never;
    }) as unknown as typeof execFileImport);

    const moveRun = vi.fn();
    initAutonomous(
      makeDeps({
        inProgressCardIds: ['c-ip'],
        reviewCardIds: [],
        moveKanbanCardRun: moveRun,
      }) as never,
    );

    await pollForMissedReviews();

    expect(mockDispatchReviewFeedback).toHaveBeenCalledTimes(1);
    expect(moveRun).not.toHaveBeenCalled();
    expect(lastDispatchedReviewId.get('c-ip')).toBe(5001);
  });

  it('persists last_dispatched_review_id to DB after successful dispatch', async () => {
    mockGetOrCreateBoard.mockReturnValue({ board: { id: 'b1' } });
    vi.mocked(execFileImport).mockImplementation(((
      _cmd: string,
      args: readonly string[] | null | undefined,
      _opts: unknown,
      cb: (err: Error | null, stdout: string, stderr: string) => void,
    ) => {
      const argv = args ?? [];
      if (argv[0] === 'api' && String(argv[1]).includes('/pulls/99/reviews')) {
        cb(null, JSON.stringify([{ id: 7001, submitted_at: '2026-05-10' }]), '');
      } else {
        cb(new Error('unexpected'), '', '');
      }
      return undefined as never;
    }) as unknown as typeof execFileImport);

    const setCardRun = vi.fn();
    initAutonomous(
      makeDeps({
        reviewCardIds: ['c-persist'],
        inProgressCardIds: [],
        setCardLastDispatchedReviewId: setCardRun,
      }) as never,
    );

    await pollForMissedReviews();

    // In-memory map updated.
    expect(lastDispatchedReviewId.get('c-persist')).toBe(7001);
    // DB persistence called with (latestId, cardId).
    expect(setCardRun).toHaveBeenCalledWith(7001, 'c-persist');
  });

  it('uses DB-persisted last_dispatched_review_id as fallback after server restart (in-memory cleared)', async () => {
    // Simulate a server restart: in-memory map is empty but the card carries
    // last_dispatched_review_id = 8000 from a previous run. The poll should
    // treat review id 8000 as already dispatched and NOT fire again for it,
    // preventing the repeated-acknowledgement bug.
    mockGetOrCreateBoard.mockReturnValue({ board: { id: 'b1' } });
    vi.mocked(execFileImport).mockImplementation(((
      _cmd: string,
      args: readonly string[] | null | undefined,
      _opts: unknown,
      cb: (err: Error | null, stdout: string, stderr: string) => void,
    ) => {
      const argv = args ?? [];
      if (argv[0] === 'api' && String(argv[1]).includes('/pulls/99/reviews')) {
        // GitHub still shows the same review (id 8000) — already dispatched.
        cb(null, JSON.stringify([{ id: 8000, submitted_at: '2026-05-09' }]), '');
      } else {
        cb(new Error('unexpected'), '', '');
      }
      return undefined as never;
    }) as unknown as typeof execFileImport);

    // lastDispatchedReviewId is empty (simulates post-restart state).
    // The card row carries last_dispatched_review_id = 8000 from the prior run.
    initAutonomous(
      makeDeps({
        reviewCardIds: ['c-restart'],
        inProgressCardIds: [],
        cardOverrides: { 'c-restart': { last_dispatched_review_id: 8000 } },
      }) as never,
    );

    await pollForMissedReviews();

    // Must NOT dispatch — review 8000 is already covered by the DB-persisted value.
    expect(mockDispatchReviewFeedback).not.toHaveBeenCalled();
  });

  it('dispatches newly-added review after restart when DB value is lower', async () => {
    // After restart, DB value is 8000. A new review (id 9000) arrived. The poll
    // should dispatch only the new review.
    mockGetOrCreateBoard.mockReturnValue({ board: { id: 'b1' } });
    vi.mocked(execFileImport).mockImplementation(((
      _cmd: string,
      args: readonly string[] | null | undefined,
      _opts: unknown,
      cb: (err: Error | null, stdout: string, stderr: string) => void,
    ) => {
      const argv = args ?? [];
      if (argv[0] === 'api' && String(argv[1]).includes('/pulls/99/reviews')) {
        cb(
          null,
          JSON.stringify([
            { id: 8000, submitted_at: '2026-05-09' },
            { id: 9000, submitted_at: '2026-05-11' },
          ]),
          '',
        );
      } else {
        cb(new Error('unexpected'), '', '');
      }
      return undefined as never;
    }) as unknown as typeof execFileImport);

    const setCardRun = vi.fn();
    initAutonomous(
      makeDeps({
        reviewCardIds: ['c-new-review'],
        inProgressCardIds: [],
        cardOverrides: { 'c-new-review': { last_dispatched_review_id: 8000 } },
        setCardLastDispatchedReviewId: setCardRun,
      }) as never,
    );

    await pollForMissedReviews();

    // Should dispatch — review 9000 is new.
    expect(mockDispatchReviewFeedback).toHaveBeenCalledTimes(1);
    // Should update DB to 9000 (the highest new review id).
    expect(setCardRun).toHaveBeenCalledWith(9000, 'c-new-review');
  });

  it('skips approved cards entirely without hitting GitHub API', async () => {
    mockGetOrCreateBoard.mockReturnValue({ board: { id: 'b1' } });
    const execFileMock = vi.mocked(execFileImport);

    initAutonomous(
      makeDeps({
        reviewCardIds: ['c-approved'],
        inProgressCardIds: [],
        cardOverrides: { 'c-approved': { review_status: 'approved' } },
      }) as never,
    );

    await pollForMissedReviews();

    // review_status === 'approved' → short-circuit before API call.
    expect(execFileMock).not.toHaveBeenCalled();
    expect(mockDispatchReviewFeedback).not.toHaveBeenCalled();
  });

  it('does not advance dedup when dispatch drops the user message (queue full path)', async () => {
    mockGetOrCreateBoard.mockReturnValue({ board: { id: 'b1' } });
    vi.mocked(execFileImport).mockImplementation(((
      _cmd: string,
      args: readonly string[] | null | undefined,
      _opts: unknown,
      cb: (err: Error | null, stdout: string, stderr: string) => void,
    ) => {
      const argv = args ?? [];
      if (argv[0] === 'api' && String(argv[1]).includes('/pulls/99/reviews')) {
        cb(null, JSON.stringify([{ id: 6001, submitted_at: '2026-05-02' }]), '');
      } else {
        cb(new Error('unexpected'), '', '');
      }
      return undefined as never;
    }) as unknown as typeof execFileImport);
    mockDispatchReviewFeedback.mockResolvedValueOnce({
      sessionId: 'sess-x',
      userMessagePersisted: false,
    });

    initAutonomous(makeDeps({ reviewCardIds: ['c-r'], inProgressCardIds: [] }) as never);

    await pollForMissedReviews();

    expect(mockDispatchReviewFeedback).toHaveBeenCalledTimes(1);
    expect(lastDispatchedReviewId.get('c-r')).toBeUndefined();
  });
});

// ─── Secondary probes added by the babysit-gap closure ───────────────────────
//
// `pollForMissedReviews` now also covers (a) failed check runs and (b) inline
// review comments where the GitHub webhook delivery was missed. These tests
// exercise the new paths via the same shared `execFile` mock used above.

/**
 * Helper to wire a multi-endpoint gh mock with one switch per GitHub URL path.
 * Each handler receives the full argv and should call cb(null, json, '').
 * Anything not matched returns an empty array string so the probe is a no-op.
 */
function wireGhMock(handlers: {
  reviews?: (argv: readonly string[]) => string;
  prSnapshot?: (argv: readonly string[]) => string;
  checkRuns?: (argv: readonly string[]) => string;
  prComments?: (argv: readonly string[]) => string;
}): void {
  vi.mocked(execFileImport).mockImplementation(((
    _cmd: string,
    args: readonly string[] | null | undefined,
    _opts: unknown,
    cb: (err: Error | null, stdout: string, stderr: string) => void,
  ) => {
    const argv = args ?? [];
    const path = String(argv[1] ?? '');
    if (argv[0] !== 'api') {
      cb(new Error('unexpected non-api gh call'), '', '');
      return undefined as never;
    }
    // Order matters: match the most specific suffix first so `/pulls/99/...`
    // doesn't match the PR-snapshot path.
    if (path.includes('/pulls/99/reviews')) {
      cb(null, handlers.reviews ? handlers.reviews(argv) : '[]', '');
    } else if (path.includes('/pulls/99/comments')) {
      cb(null, handlers.prComments ? handlers.prComments(argv) : '[]', '');
    } else if (path.includes('/check-runs')) {
      // gh --jq projection collapses the envelope; default is an empty array.
      cb(null, handlers.checkRuns ? handlers.checkRuns(argv) : '[]', '');
    } else if (/\/pulls\/99(?:$|\?)/.test(path)) {
      cb(
        null,
        handlers.prSnapshot
          ? handlers.prSnapshot(argv)
          : JSON.stringify({ state: 'open', head_sha: 'sha-deadbeef' }),
        '',
      );
    } else {
      cb(new Error(`unexpected gh path: ${path}`), '', '');
    }
    return undefined as never;
  }) as unknown as typeof execFileImport);
}

describe('pollForMissedReviews — CI failure probe', () => {
  it('dispatches CI fix when a new failed check run appears', async () => {
    mockGetOrCreateBoard.mockReturnValue({ board: { id: 'b1' } });
    wireGhMock({
      prSnapshot: () => JSON.stringify({ state: 'open', head_sha: 'sha-1' }),
      checkRuns: () =>
        JSON.stringify([
          { id: 1001, name: 'lint', conclusion: 'success' },
          { id: 1002, name: 'unit-tests', conclusion: 'failure' },
          { id: 1003, name: 'e2e', conclusion: 'timed_out' },
        ]),
    });

    const setCheckRun = vi.fn();
    initAutonomous(
      makeDeps({
        reviewCardIds: ['c-ci'],
        setCardLastDispatchedCheckRunId: setCheckRun,
      }) as never,
    );

    await pollForMissedReviews();

    expect(mockDispatchReviewFeedback).toHaveBeenCalledTimes(1);
    const [, , , content] = mockDispatchReviewFeedback.mock.calls[0] as [
      unknown,
      unknown,
      unknown,
      string,
    ];
    expect(content).toMatch(/Missed CI Failure/);
    expect(content).toMatch(/unit-tests/);
    expect(content).toMatch(/e2e/);
    // Latest of the two failing ids → 1003.
    expect(setCheckRun).toHaveBeenCalledWith(1003, 'c-ci');
  });

  it('respects last_dispatched_check_run_id to avoid re-firing the same failure', async () => {
    mockGetOrCreateBoard.mockReturnValue({ board: { id: 'b1' } });
    wireGhMock({
      prSnapshot: () => JSON.stringify({ state: 'open', head_sha: 'sha-2' }),
      // Same failure (id 2000) we already dispatched last cycle.
      checkRuns: () => JSON.stringify([{ id: 2000, name: 'unit-tests', conclusion: 'failure' }]),
    });

    initAutonomous(
      makeDeps({
        reviewCardIds: ['c-ci-dedup'],
        cardOverrides: { 'c-ci-dedup': { last_dispatched_check_run_id: 2000 } },
      }) as never,
    );

    await pollForMissedReviews();

    expect(mockDispatchReviewFeedback).not.toHaveBeenCalled();
  });

  it('skips secondary probes entirely when PR is closed', async () => {
    mockGetOrCreateBoard.mockReturnValue({ board: { id: 'b1' } });
    const checkRunsHandler = vi.fn(() => '[]');
    wireGhMock({
      prSnapshot: () => JSON.stringify({ state: 'closed', head_sha: 'sha-3' }),
      checkRuns: checkRunsHandler,
    });

    initAutonomous(makeDeps({ reviewCardIds: ['c-closed'] }) as never);

    await pollForMissedReviews();

    expect(checkRunsHandler).not.toHaveBeenCalled();
    expect(mockDispatchReviewFeedback).not.toHaveBeenCalled();
  });

  it('does not advance check-run dedup when dispatch drops the user message', async () => {
    mockGetOrCreateBoard.mockReturnValue({ board: { id: 'b1' } });
    wireGhMock({
      prSnapshot: () => JSON.stringify({ state: 'open', head_sha: 'sha-4' }),
      checkRuns: () => JSON.stringify([{ id: 4242, name: 'lint', conclusion: 'failure' }]),
    });
    mockDispatchReviewFeedback.mockResolvedValueOnce({
      sessionId: 'sess-x',
      userMessagePersisted: false,
    });

    const setCheckRun = vi.fn();
    initAutonomous(
      makeDeps({
        reviewCardIds: ['c-ci-drop'],
        setCardLastDispatchedCheckRunId: setCheckRun,
      }) as never,
    );

    await pollForMissedReviews();

    expect(mockDispatchReviewFeedback).toHaveBeenCalledTimes(1);
    expect(setCheckRun).not.toHaveBeenCalled();
  });
});

describe('pollForMissedReviews — inline review comment probe', () => {
  it('dispatches author feedback when a new non-bot inline comment appears', async () => {
    mockGetOrCreateBoard.mockReturnValue({ board: { id: 'b1' } });
    wireGhMock({
      prSnapshot: () => JSON.stringify({ state: 'open', head_sha: 'sha-c1' }),
      prComments: () =>
        JSON.stringify([
          {
            id: 5005,
            body: 'this needs a null check',
            path: 'server/foo.ts',
            line: 42,
            user: 'reviewer-jane',
          },
        ]),
    });

    const setCommentId = vi.fn();
    initAutonomous(
      makeDeps({
        reviewCardIds: ['c-cmt'],
        setCardLastDispatchedReviewCommentId: setCommentId,
      }) as never,
    );

    await pollForMissedReviews();

    expect(mockDispatchReviewFeedback).toHaveBeenCalledTimes(1);
    const [, , , content] = mockDispatchReviewFeedback.mock.calls[0] as [
      unknown,
      unknown,
      unknown,
      string,
    ];
    expect(content).toMatch(/Missed Inline Review Comment/);
    expect(content).toMatch(/server\/foo\.ts/);
    expect(content).toMatch(/reviewer-jane/);
    expect(setCommentId).toHaveBeenCalledWith(5005, 'c-cmt');
  });

  it('filters out bot, self, and agent-hub-bot-marked comments', async () => {
    mockGetOrCreateBoard.mockReturnValue({ board: { id: 'b1' } });
    wireGhMock({
      prSnapshot: () => JSON.stringify({ state: 'open', head_sha: 'sha-c2' }),
      prComments: () =>
        JSON.stringify([
          { id: 1, body: 'CI says hi', path: '.', line: 1, user: 'github-actions[bot]' },
          { id: 2, body: 'self note', path: '.', line: 1, user: 'human' }, // = ghAuthenticatedUser
          { id: 3, body: 'bot reply', path: '.', line: 1, user: 'agent-hub-bot' },
          {
            id: 4,
            body: '<!-- agent-hub-bot --> already addressed',
            path: '.',
            line: 1,
            user: 'someone-else',
          },
        ]),
    });

    initAutonomous(
      makeDeps({
        reviewCardIds: ['c-cmt-filter'],
        getGhBotUser: vi.fn(() => 'agent-hub-bot'),
      }) as never,
    );

    await pollForMissedReviews();

    expect(mockDispatchReviewFeedback).not.toHaveBeenCalled();
  });

  it('respects last_dispatched_review_comment_id to avoid re-firing', async () => {
    mockGetOrCreateBoard.mockReturnValue({ board: { id: 'b1' } });
    wireGhMock({
      prSnapshot: () => JSON.stringify({ state: 'open', head_sha: 'sha-c3' }),
      prComments: () =>
        JSON.stringify([
          // Old comment we already dispatched.
          { id: 100, body: 'old', path: 'a.ts', line: 1, user: 'reviewer' },
          // Same id — should be skipped because dedup is by `>`.
          { id: 100, body: 'old again', path: 'a.ts', line: 1, user: 'reviewer' },
        ]),
    });

    initAutonomous(
      makeDeps({
        reviewCardIds: ['c-cmt-dedup'],
        cardOverrides: { 'c-cmt-dedup': { last_dispatched_review_comment_id: 100 } },
      }) as never,
    );

    await pollForMissedReviews();

    expect(mockDispatchReviewFeedback).not.toHaveBeenCalled();
  });
});
