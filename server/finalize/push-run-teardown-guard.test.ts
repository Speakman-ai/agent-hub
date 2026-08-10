/**
 * The background-shell teardown documents itself as non-throwing, and
 * `post-push-background-shells.test.ts` pins that contract directly. This file
 * pins the *independent* layer: even if that contract is ever broken by a
 * regression, a push that is already persisted and already has a PR on GitHub
 * must still be reported as succeeded, with its completion broadcasts intact.
 *
 * So the module is mocked to do the one thing it promises never to do.
 */
import { describe, expect, it, vi } from 'vitest';
import type { FinalizeRunRow, KanbanCardRow, Project, SessionRow } from '../types.js';

vi.mock('./worktree-changes.js', () => ({
  getSessionCommittableChanges: vi
    .fn()
    .mockResolvedValue({ ok: true, changes: { hasUnpushed: true } }),
}));

vi.mock('../native-pr/author-user.js', () => ({
  resolveNativePrAuthorUserId: vi.fn(() => 'u1'),
  isKnownHubUserId: vi.fn(() => true),
}));

vi.mock('./post-push-background-shells.js', () => ({
  stopBackgroundShellsAfterFinalizePush: vi
    .fn()
    .mockRejectedValue(new Error('contract violated by a future regression')),
}));

const { runFinalizePush } = await import('./push-run.js');

const baseRun = (): FinalizeRunRow =>
  ({
    id: 'run-1',
    card_id: 'card-1',
    session_id: 'sess-1',
    project_id: 'proj-1',
    branch: 'feature/x',
    head_sha: 'abc123',
    idempotency_key: 'idem',
    status: 'ready_to_push',
    phase: null,
    trigger_source: 'ui_button',
    worktree_path: '/tmp/wt',
    triggered_by_user_id: 'u1',
    author_name: 'Test',
    author_email: 'test@example.com',
    reviewer_verdict: 'approved',
    failure_reason: null,
    failed_step_index: null,
    failed_step_name: null,
    failed_step_exit_code: null,
    retry_of_run_id: null,
    active_seconds_consumed: 0,
    started_at: 1,
    ended_at: null,
    pr_url: null,
    validated_head_sha: null,
  }) as FinalizeRunRow;

const card = { id: 'card-1', pr_base_branch: 'main' } as KanbanCardRow;
const session = {
  id: 'sess-1',
  worktree_path: '/tmp/wt',
  worktree_branch: 'feature/x',
} as SessionRow;
const project = { id: 'proj-1', githubRepo: 'o/r' } as Project;

function makeDeps() {
  const broadcast = vi.fn();
  return {
    deps: {
      stmts: {
        updateFinalizeRunPhase: { run: vi.fn() },
        claimFinalizeRunPush: { run: vi.fn(() => ({ changes: 1 })) },
        failFinalizeRun: { run: vi.fn() },
        markFinalizeRunPushed: { run: vi.fn() },
        updateSessionAskMode: { run: vi.fn() },
        updateSessionFinalizeAutomation: { run: vi.fn() },
        updateFinalizeRunPrUrl: { run: vi.fn() },
        getFinalizeRun: { get: vi.fn(() => ({ ...baseRun(), status: 'pushing' })) },
        getFinalizePushPeerForSessionHead: { get: vi.fn(() => undefined) },
        getLatestFinalizeRunForSession: { get: vi.fn(() => undefined) },
        getPushedFinalizeRunForSession: { get: vi.fn(() => undefined) },
        getLatestChecksRunForSession: { get: vi.fn(() => baseRun()) },
        getLatestReviewRunForSession: { get: vi.fn(() => baseRun()) },
        addMessage: { run: vi.fn() },
        touchSession: { run: vi.fn() },
        getMessageById: { get: vi.fn(() => undefined) },
        getKanbanEpic: { get: vi.fn(() => undefined) },
      },
      broadcast,
      config: {},
      findAgent: vi.fn(),
    },
    broadcast,
  };
}

describe('runFinalizePush background-shell teardown guard', () => {
  it('reports the push as succeeded even when the teardown rejects', async () => {
    const { deps, broadcast } = makeDeps();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      const outcome = await runFinalizePush({
        deps: deps as never,
        project,
        run: baseRun(),
        card,
        session,
        force: true,
        resolveHeadSha: vi.fn().mockResolvedValue('abc123'),
        pushAndCreatePr: vi.fn().mockResolvedValue({ prUrl: 'https://github.com/o/r/pull/1' }),
      });

      expect(outcome).toMatchObject({ ok: true, prUrl: 'https://github.com/o/r/pull/1' });
      const types = broadcast.mock.calls.map((c) => (c[0] as { type?: string }).type);
      expect(types).toContain('finalize_run_phase_changed');
      expect(types).toContain('finalize_run_completed');
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('background-shell teardown threw'));
    } finally {
      warn.mockRestore();
    }
  });
});
