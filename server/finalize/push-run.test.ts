import { describe, expect, it, vi } from 'vitest';
import { resolvePushGateBaseline, runFinalizePush, runSessionPushToGithub } from './push-run.js';
import { resolveNativePrAuthorUserId } from '../native-pr/author-user.js';
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
  const addMessage = { run: vi.fn() };
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
        // Timeline-message writes (terminal block) need these.
        addMessage,
        touchSession: { run: vi.fn() },
        getMessageById: { get: vi.fn(() => undefined) },
        getKanbanEpic: { get: vi.fn(() => undefined) },
      },
      broadcast,
      config: {},
      findAgent: vi.fn(),
    },
    broadcast,
    addMessage,
  };
}

/** Pull the parsed metadata from the last `finalize_run_terminal` timeline write. */
function lastTerminalMetadata(addMessage: { run: { mock: { calls: unknown[][] } } }) {
  const calls = addMessage.run.mock.calls;
  for (let i = calls.length - 1; i >= 0; i--) {
    const meta = JSON.parse(calls[i][7] as string);
    if (meta.kind === 'finalize_run_terminal') return meta;
  }
  return null;
}

describe('runFinalizePush native-PR attribution gating', () => {
  it('does not resolve native-PR attribution for a GitHub-backed project (passes authorUserId=null)', async () => {
    // Regression: native-PR author attribution applies ONLY to Agent
    // Hub-hosted PR rows. For a GitHub project, resolving it before pushFn
    // could fail an auth-enabled/userless session in resolveNativePrAuthorUserId
    // even though GitHub PR creation needs no Hub author.
    const { deps } = makeDeps();
    const mockResolve = vi.mocked(resolveNativePrAuthorUserId);
    mockResolve.mockClear();
    const pushAndCreatePr = vi.fn().mockResolvedValue({ prUrl: 'https://github.com/o/r/pull/1' });
    const githubProject = { id: 'proj-1', githubRepo: 'o/r' } as Project; // no gitHost

    const outcome = await runFinalizePush({
      deps: deps as never,
      project: githubProject,
      run: baseRun(),
      card,
      session,
      force: true,
      resolveHeadSha: vi.fn().mockResolvedValue('abc123'),
      pushAndCreatePr,
    });

    expect(outcome.ok).toBe(true);
    expect(mockResolve).not.toHaveBeenCalled();
    expect(pushAndCreatePr.mock.calls[0]![0]).toMatchObject({ authorUserId: null });
  });

  it('resolves native-PR attribution for an Agent Hub-hosted project', async () => {
    const { deps } = makeDeps();
    const mockResolve = vi.mocked(resolveNativePrAuthorUserId);
    mockResolve.mockClear();
    mockResolve.mockReturnValue('u1');
    const pushAndCreatePr = vi.fn().mockResolvedValue({ prUrl: '/projects/proj-1/pulls/1' });
    const hostedProject = { id: 'proj-1', gitHost: 'agenthub' } as Project;

    const outcome = await runFinalizePush({
      deps: deps as never,
      project: hostedProject,
      run: baseRun(),
      card,
      session,
      force: true,
      resolveHeadSha: vi.fn().mockResolvedValue('abc123'),
      pushAndCreatePr,
    });

    expect(outcome.ok).toBe(true);
    expect(mockResolve).toHaveBeenCalledOnce();
    expect(pushAndCreatePr.mock.calls[0]![0]).toMatchObject({ authorUserId: 'u1' });
  });
});

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

  it('refuses a cancelled run even with force=true', async () => {
    // Regression: pressing Stop during Finalize must be authoritative. A
    // cancelled run is never pushable, including via the force bypass, so a
    // stale push dispatch can never ship a run the user stopped.
    const { deps } = makeDeps();
    const pushAndCreatePr = vi.fn();
    const run = { ...baseRun(), status: 'cancelled' as const };

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

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error).toBe('cancelled');
      expect(outcome.httpStatus).toBe(409);
    }
    expect(pushAndCreatePr).not.toHaveBeenCalled();
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

  it('claims ready_to_push before GitHub work so duplicate push callers cannot create duplicate PRs', async () => {
    const { deps } = makeDeps();
    let releasePush: () => void = () => {};
    let markStarted: () => void = () => {};
    const firstPushStarted = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const pushAndCreatePr = vi.fn(
      () =>
        new Promise<{ prUrl: string }>((resolvePush) => {
          markStarted();
          releasePush = () => resolvePush({ prUrl: 'https://github.com/o/r/pull/10' });
        }),
    );
    (deps.stmts.claimFinalizeRunPush.run as ReturnType<typeof vi.fn>)
      .mockReturnValueOnce({ changes: 1 })
      .mockReturnValueOnce({ changes: 0 });
    (deps.stmts.getFinalizeRun.get as ReturnType<typeof vi.fn>).mockReturnValue({
      ...baseRun(),
      status: 'pushing',
    });

    const first = runFinalizePush({
      deps: deps as never,
      project,
      run: baseRun(),
      card,
      session,
      resolveHeadSha: vi.fn().mockResolvedValue('abc123'),
      resolveCurrentBranch: vi.fn().mockResolvedValue('feature/x'),
      pushAndCreatePr,
    });

    await firstPushStarted;

    const second = await runFinalizePush({
      deps: deps as never,
      project,
      run: baseRun(),
      card,
      session,
      resolveHeadSha: vi.fn().mockResolvedValue('abc123'),
      resolveCurrentBranch: vi.fn().mockResolvedValue('feature/x'),
      pushAndCreatePr,
    });

    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.error).toBe('push_in_flight');
    }
    expect(pushAndCreatePr).toHaveBeenCalledOnce();
    releasePush();
    await expect(first).resolves.toMatchObject({
      ok: true,
      prUrl: 'https://github.com/o/r/pull/10',
    });
  });

  it('locks the session in ask mode after a successful Finalize push', async () => {
    const { deps } = makeDeps();
    const pushAndCreatePr = vi.fn().mockResolvedValue({ prUrl: 'https://github.com/o/r/pull/1' });

    const outcome = await runFinalizePush({
      deps: deps as never,
      project,
      run: baseRun(),
      card,
      session,
      resolveHeadSha: vi.fn().mockResolvedValue('abc123'),
      pushAndCreatePr,
    });

    expect(outcome.ok).toBe(true);
    expect(deps.stmts.updateSessionAskMode.run).toHaveBeenCalledWith(1, 'sess-1');
    expect(deps.stmts.updateSessionFinalizeAutomation.run).toHaveBeenCalledWith('manual', 'sess-1');
  });

  it('refuses a follow-up Finalize push after the session already pushed code', async () => {
    const { deps } = makeDeps();
    (deps.stmts.getPushedFinalizeRunForSession.get as ReturnType<typeof vi.fn>).mockReturnValue({
      ...baseRun(),
      status: 'pushed',
    });
    const pushAndCreatePr = vi.fn();

    const outcome = await runFinalizePush({
      deps: deps as never,
      project,
      run: baseRun(),
      card,
      session,
      resolveHeadSha: vi.fn().mockResolvedValue('abc123'),
      pushAndCreatePr,
    });

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.httpStatus).toBe(409);
      expect(outcome.error).toBe('session_finalized_pushed');
    }
    expect(deps.stmts.claimFinalizeRunPush.run).not.toHaveBeenCalled();
    expect(pushAndCreatePr).not.toHaveBeenCalled();
  });

  it('does not push a second finalize run while another push for the session is in flight', async () => {
    const { deps } = makeDeps();
    const pushAndCreatePr = vi.fn();
    (deps.stmts.claimFinalizeRunPush.run as ReturnType<typeof vi.fn>).mockReturnValue({
      changes: 0,
    });
    (deps.stmts.getFinalizePushPeerForSessionHead.get as ReturnType<typeof vi.fn>).mockReturnValue({
      ...baseRun(),
      id: 'run-peer',
      status: 'pushing',
      validated_head_sha: 'older-head',
    });

    const outcome = await runFinalizePush({
      deps: deps as never,
      project,
      run: { ...baseRun(), id: 'run-2', validated_head_sha: 'abc123' },
      card,
      session,
      resolveHeadSha: vi.fn().mockResolvedValue('abc123'),
      resolveCurrentBranch: vi.fn().mockResolvedValue('feature/x'),
      pushAndCreatePr,
    });

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error).toBe('push_in_flight');
    }
    expect(deps.stmts.claimFinalizeRunPush.run).toHaveBeenCalledWith('run-2', 'abc123');
    expect(deps.stmts.getFinalizePushPeerForSessionHead.get).toHaveBeenCalledWith(
      'run-2',
      'sess-1',
      'abc123',
    );
    expect(pushAndCreatePr).not.toHaveBeenCalled();
  });

  it('reuses an already pushed peer for the same session and validated head without pushing again', async () => {
    const { deps } = makeDeps();
    const pushAndCreatePr = vi.fn();
    (deps.stmts.claimFinalizeRunPush.run as ReturnType<typeof vi.fn>).mockReturnValue({
      changes: 0,
    });
    (deps.stmts.getFinalizePushPeerForSessionHead.get as ReturnType<typeof vi.fn>).mockReturnValue({
      ...baseRun(),
      id: 'run-peer',
      status: 'pushed',
      pr_url: 'https://github.com/o/r/pull/10',
      validated_head_sha: 'abc123',
    });

    const outcome = await runFinalizePush({
      deps: deps as never,
      project,
      run: { ...baseRun(), id: 'run-2', validated_head_sha: 'abc123' },
      card,
      session,
      resolveHeadSha: vi.fn().mockResolvedValue('abc123'),
      resolveCurrentBranch: vi.fn().mockResolvedValue('feature/x'),
      pushAndCreatePr,
    });

    expect(outcome).toEqual({ ok: true, prUrl: 'https://github.com/o/r/pull/10' });
    expect(deps.stmts.updateFinalizeRunPrUrl.run).toHaveBeenCalledWith(
      'https://github.com/o/r/pull/10',
      'run-2',
    );
    expect(deps.stmts.markFinalizeRunPushed.run).toHaveBeenCalledWith('run-2');
    expect(pushAndCreatePr).not.toHaveBeenCalled();
  });
});

describe('bypassed-gates timeline', () => {
  it('marks a forced finalize push with bypassedGates=true', async () => {
    const { deps, addMessage } = makeDeps();
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
    expect(lastTerminalMetadata(addMessage)?.bypassedGates).toBe(true);
  });

  it('marks a gated ready_to_push push with bypassedGates=false', async () => {
    const { deps, addMessage } = makeDeps();
    const pushAndCreatePr = vi.fn().mockResolvedValue({ prUrl: 'https://github.com/o/r/pull/2' });

    const outcome = await runFinalizePush({
      deps: deps as never,
      project,
      run: baseRun(), // status: ready_to_push, reviewer approved
      card,
      session,
      resolveHeadSha: vi.fn().mockResolvedValue('abc123'),
      pushAndCreatePr,
    });

    expect(outcome.ok).toBe(true);
    const meta = lastTerminalMetadata(addMessage);
    expect(meta?.status).toBe('pushed');
    expect(meta?.bypassedGates).toBe(false);
  });

  it('posts an approved native-PR review after a gated push to a hosted PR (regression)', async () => {
    // Regression: a Resolve-PR session that fixes a `changes_requested` PR and
    // passes Finalize review used to leave the PR stuck at CHANGES_REQUESTED —
    // the approval was never mirrored onto the native PR. A gated (non-forced)
    // push to a native PR must now post an `approved` review.
    const { deps } = makeDeps();
    const submitReview = vi.fn((_arg: Record<string, unknown>) => ({ review: {} }));
    (deps.stmts as Record<string, unknown>).listReviewerThreadsForRun = { all: vi.fn(() => []) };
    (deps as Record<string, unknown>).nativePr = { submitReview };
    const hostedProject = {
      id: 'proj-1',
      gitHost: 'agenthub',
      agents: [{ id: 'rev', name: 'Proj Reviewer', role: 'reviewer' }],
    } as unknown as Project;
    const pushAndCreatePr = vi.fn().mockResolvedValue({ prUrl: '/projects/proj-1/pulls/7' });

    const outcome = await runFinalizePush({
      deps: deps as never,
      project: hostedProject,
      run: baseRun(), // ready_to_push, reviewer approved
      card,
      session,
      resolveHeadSha: vi.fn().mockResolvedValue('abc123'),
      pushAndCreatePr,
    });

    expect(outcome.ok).toBe(true);
    expect(submitReview).toHaveBeenCalledTimes(1);
    expect(submitReview.mock.calls[0]![0]).toMatchObject({
      number: 7,
      state: 'approved',
      reviewer: 'Proj Reviewer',
    });
  });

  it('does not post an approved review on a forced (gate-bypassed) push', async () => {
    const { deps } = makeDeps();
    const submitReview = vi.fn((_arg: Record<string, unknown>) => ({ review: {} }));
    (deps.stmts as Record<string, unknown>).listReviewerThreadsForRun = { all: vi.fn(() => []) };
    (deps as Record<string, unknown>).nativePr = { submitReview };
    const hostedProject = {
      id: 'proj-1',
      gitHost: 'agenthub',
      agents: [{ id: 'rev', name: 'Proj Reviewer', role: 'reviewer' }],
    } as unknown as Project;
    const pushAndCreatePr = vi.fn().mockResolvedValue({ prUrl: '/projects/proj-1/pulls/8' });

    const outcome = await runFinalizePush({
      deps: deps as never,
      project: hostedProject,
      run: { ...baseRun(), status: 'dispatching' as const },
      card,
      session,
      force: true,
      resolveHeadSha: vi.fn().mockResolvedValue('abc123'),
      pushAndCreatePr,
    });

    expect(outcome.ok).toBe(true);
    expect(submitReview).not.toHaveBeenCalled();
  });

  it('marks a session push (no finalize run) with bypassedGates=true', async () => {
    const { deps, addMessage } = makeDeps();
    const pushAndCreatePr = vi.fn().mockResolvedValue({ prUrl: 'https://github.com/o/r/pull/3' });

    const outcome = await runSessionPushToGithub({
      deps: deps as never,
      project,
      session,
      card,
      resolveHeadSha: vi.fn().mockResolvedValue('abc123'),
      resolveCurrentBranch: vi.fn().mockResolvedValue('feature/x'),
      pushAndCreatePr,
    });

    expect(outcome.ok).toBe(true);
    const meta = lastTerminalMetadata(addMessage);
    expect(meta?.status).toBe('pushed');
    expect(meta?.bypassedGates).toBe(true);
  });
});

describe('runFinalizePush branch resolution', () => {
  it('pushes the worktree checked-out branch when it differs from stored worktree_branch', async () => {
    // Regression: the agent switched the worktree onto a new branch
    // mid-session, but session.worktree_branch stayed stale. The push must
    // target the checked-out branch (which holds the validated HEAD), not
    // the stale stored name — otherwise gh pr create fails with
    // "No commits between …" and is mislabeled github_push_5xx.
    const { deps } = makeDeps();
    const pushAndCreatePr = vi.fn().mockResolvedValue({ prUrl: 'https://github.com/o/r/pull/1' });

    const outcome = await runFinalizePush({
      deps: deps as never,
      project,
      run: baseRun(),
      card,
      session, // worktree_branch: 'feature/x'
      resolveHeadSha: vi.fn().mockResolvedValue('abc123'),
      resolveCurrentBranch: vi.fn().mockResolvedValue('feature/actual-work'),
      pushAndCreatePr,
    });

    expect(outcome.ok).toBe(true);
    expect(pushAndCreatePr).toHaveBeenCalledOnce();
    expect(pushAndCreatePr.mock.calls[0][0]).toMatchObject({ branch: 'feature/actual-work' });
  });

  it('falls back to stored worktree_branch when the worktree is detached (resolver returns null)', async () => {
    const { deps } = makeDeps();
    const pushAndCreatePr = vi.fn().mockResolvedValue({ prUrl: 'https://github.com/o/r/pull/2' });

    const outcome = await runFinalizePush({
      deps: deps as never,
      project,
      run: baseRun(),
      card,
      session, // worktree_branch: 'feature/x'
      resolveHeadSha: vi.fn().mockResolvedValue('abc123'),
      resolveCurrentBranch: vi.fn().mockResolvedValue(null),
      pushAndCreatePr,
    });

    expect(outcome.ok).toBe(true);
    expect(pushAndCreatePr.mock.calls[0][0]).toMatchObject({ branch: 'feature/x' });
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

  it('allows push when split checks and review runs validated the same current HEAD', async () => {
    const { deps } = makeDeps();
    const pushAndCreatePr = vi.fn().mockResolvedValue({ prUrl: 'https://github.com/o/r/pull/1' });
    const checksRun = {
      ...baseRun(),
      id: 'run-checks',
      mode: 'checks' as const,
      reviewer_verdict: null,
      validated_head_sha: 'split-head',
    };
    const reviewRun = {
      ...baseRun(),
      id: 'run-review',
      mode: 'review' as const,
      reviewer_verdict: 'approved' as const,
      validated_head_sha: 'split-head',
    };
    (deps.stmts.getLatestChecksRunForSession.get as ReturnType<typeof vi.fn>).mockReturnValue(
      checksRun,
    );
    (deps.stmts.getLatestReviewRunForSession.get as ReturnType<typeof vi.fn>).mockReturnValue(
      reviewRun,
    );

    const outcome = await runFinalizePush({
      deps: deps as never,
      project,
      run: checksRun,
      card,
      session,
      resolveHeadSha: vi.fn().mockResolvedValue('split-head'),
      resolveCurrentBranch: vi.fn().mockResolvedValue('feature/x'),
      pushAndCreatePr,
    });

    expect(outcome.ok).toBe(true);
    expect(pushAndCreatePr).toHaveBeenCalledOnce();
    expect(deps.stmts.claimFinalizeRunPush.run).toHaveBeenCalledWith('run-checks', 'split-head');
  });

  it('rejects split phase push when the reviewer run validated a different HEAD', async () => {
    const { deps } = makeDeps();
    const checksRun = {
      ...baseRun(),
      id: 'run-checks',
      mode: 'checks' as const,
      reviewer_verdict: null,
      validated_head_sha: 'current-head',
    };
    const reviewRun = {
      ...baseRun(),
      id: 'run-review',
      mode: 'review' as const,
      reviewer_verdict: 'approved' as const,
      validated_head_sha: 'old-reviewed-head',
    };
    (deps.stmts.getLatestChecksRunForSession.get as ReturnType<typeof vi.fn>).mockReturnValue(
      checksRun,
    );
    (deps.stmts.getLatestReviewRunForSession.get as ReturnType<typeof vi.fn>).mockReturnValue(
      reviewRun,
    );

    const outcome = await runFinalizePush({
      deps: deps as never,
      project,
      run: checksRun,
      card,
      session,
      resolveHeadSha: vi.fn().mockResolvedValue('current-head'),
      pushAndCreatePr: vi.fn(),
    });

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error).toBe('reviewer_not_approved');
    }
  });
});
