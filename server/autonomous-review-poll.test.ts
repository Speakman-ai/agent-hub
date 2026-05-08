import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import type { KanbanCardRow } from './types.js';

vi.mock('child_process', () => ({
  execFile: vi.fn(),
}));

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

function makeDeps(overrides: {
  reviewCardIds?: string[];
  inProgressCardIds?: string[];
  moveKanbanCardRun?: Mock;
}): Parameters<typeof initAutonomous>[0] {
  const reviewId = 'col-review';
  const inProgressId = 'col-progress';
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
            cards.push({
              id,
              column_id: reviewId,
              title: `Card ${id}`,
              pr_url: 'https://github.com/o/r/pull/99',
            } as KanbanCardRow);
          }
        }
        for (const id of overrides.inProgressCardIds || []) {
          if (colId === inProgressId) {
            cards.push({
              id,
              column_id: inProgressId,
              title: `Card ${id}`,
              pr_url: 'https://github.com/o/r/pull/99',
            } as KanbanCardRow);
          }
        }
        return cards;
      }),
    },
    moveKanbanCard: { run: overrides.moveKanbanCardRun || vi.fn() },
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
