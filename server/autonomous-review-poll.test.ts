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
}

function makeDeps(overrides: {
  reviewCardIds?: string[];
  inProgressCardIds?: string[];
  moveKanbanCardRun?: Mock;
  setCardLastDispatchedReviewId?: Mock;
  /** Per-card property overrides keyed by card id. */
  cardOverrides?: Record<string, CardOverride>;
}): Parameters<typeof initAutonomous>[0] {
  const reviewId = 'col-review';
  const inProgressId = 'col-progress';
  const setCardLastDispatchedReviewIdRun = overrides.setCardLastDispatchedReviewId || vi.fn();
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
            } as KanbanCardRow);
          }
        }
        return cards;
      }),
    },
    moveKanbanCard: { run: overrides.moveKanbanCardRun || vi.fn() },
    setCardLastDispatchedReviewId: { run: setCardLastDispatchedReviewIdRun },
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
