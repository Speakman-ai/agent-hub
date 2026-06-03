import { describe, expect, it, vi } from 'vitest';
import { resolvePushGateBaseline, runFinalizePush } from './push-run.js';
import type { FinalizeRunRow, KanbanCardRow, Project, SessionRow } from '../types.js';

vi.mock('./worktree-changes.js', () => ({
  getSessionCommittableChanges: vi
    .fn()
    .mockResolvedValue({ ok: true, changes: { hasUnpushed: true } }),
}));

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
        failFinalizeRun: { run: vi.fn() },
        markFinalizeRunPushed: { run: vi.fn() },
        updateFinalizeRunPrUrl: { run: vi.fn() },
      },
      broadcast,
      config: {},
      findAgent: vi.fn(),
    },
    broadcast,
  };
}

describe('runFinalizePush force', () => {
  it('allows push when force=true even if status is dispatching', async () => {
    const { deps } = makeDeps();
    const pushAndCreatePr = vi.fn().mockResolvedValue({ prUrl: 'https://github.com/o/r/pull/1' });
    const run = {
      ...baseRun(),
      status: 'dispatching' as const,
      reviewer_verdict: 'changes_requested' as const,
    };

    const outcome = await runFinalizePush({
      deps: deps as never,
      project,
      run,
      card,
      session,
      force: true,
      resolveHeadSha: vi.fn().mockResolvedValue('abc123'),
      pushAndCreatePr,
    });

    expect(outcome.ok).toBe(true);
    expect(pushAndCreatePr).toHaveBeenCalledOnce();
  });

  it('rejects push without force when not ready_to_push', async () => {
    const { deps } = makeDeps();
    const run = { ...baseRun(), status: 'running' as const };

    const outcome = await runFinalizePush({
      deps: deps as never,
      project,
      run,
      card,
      session,
      resolveHeadSha: vi.fn().mockResolvedValue('abc123'),
      pushAndCreatePr: vi.fn(),
    });

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error).toBe('not_ready_to_push');
    }
  });
});

describe('resolvePushGateBaseline', () => {
  it('prefers validated_head_sha over trigger-time head_sha', () => {
    const run = { ...baseRun(), head_sha: 'trigger-old', validated_head_sha: 'validated-new' };
    expect(resolvePushGateBaseline(run, 'current-head')).toBe('validated-new');
  });

  it('accepts current HEAD for legacy ready_to_push rows without validated_head_sha', () => {
    const run = { ...baseRun(), head_sha: 'trigger-old', validated_head_sha: null };
    expect(resolvePushGateBaseline(run, 'current-head')).toBe('current-head');
  });
});

describe('runFinalizePush validated head', () => {
  it('allows push when trigger head_sha differs but validated_head_sha matches current HEAD', async () => {
    const { deps } = makeDeps();
    const pushAndCreatePr = vi.fn().mockResolvedValue({ prUrl: 'https://github.com/o/r/pull/1' });
    const run = {
      ...baseRun(),
      head_sha: 'c07d8c1-trigger',
      validated_head_sha: '3675b1b-validated',
    };

    const outcome = await runFinalizePush({
      deps: deps as never,
      project,
      run,
      card,
      session,
      resolveHeadSha: vi.fn().mockResolvedValue('3675b1b-validated'),
      pushAndCreatePr,
    });

    expect(outcome.ok).toBe(true);
    expect(pushAndCreatePr).toHaveBeenCalledOnce();
  });

  it('rejects push when validated_head_sha no longer matches current HEAD', async () => {
    const { deps } = makeDeps();
    const run = {
      ...baseRun(),
      validated_head_sha: '3675b1b-validated',
    };

    const outcome = await runFinalizePush({
      deps: deps as never,
      project,
      run,
      card,
      session,
      resolveHeadSha: vi.fn().mockResolvedValue('deadbeef-new-commit'),
      pushAndCreatePr: vi.fn(),
    });

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error).toBe('head_sha_moved');
    }
  });
});
