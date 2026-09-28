import { describe, expect, it, vi } from 'vitest';
import {
  isFinalizeRunPushInProgress,
  runFinalizePush,
  runSessionPushToGithub,
} from './push-run.js';
import { postFinalizeApprovalReview } from './post-finalize-approval-review.js';
import type { FinalizeRunRow, KanbanCardRow, Project, SessionRow } from '../types.js';
import {
  type AutopilotSessionConfig,
  parseAutopilotSessionConfig,
} from '../../shared/utils/sessionAutopilot.js';
import { idleMainlineSlot, type MainlineSlot } from '../../shared/utils/autopilotMainlineSlot.js';
import type { DefaultBranchGitRunner } from './push-to-default-branch.js';

vi.mock('./worktree-changes.js', () => ({
  getSessionCommittableChanges: vi
    .fn()
    .mockResolvedValue({ ok: true, changes: { hasUnpushed: true } }),
}));
vi.mock('../native-pr/author-user.js', () => ({
  resolveNativePrAuthorUserId: vi.fn(() => 'u1'),
  isKnownHubUserId: vi.fn(() => true),
}));
vi.mock('./post-finalize-approval-review.js', () => ({
  postFinalizeApprovalReview: vi.fn(),
}));

const SHA = 'abc1234def5678abc1234def5678abc1234def56';

const run = (): FinalizeRunRow =>
  ({
    id: 'run-1',
    card_id: 'card-1',
    session_id: 'sess-1',
    project_id: 'proj-1',
    branch: 'agent-hub/dev/session-1',
    head_sha: SHA,
    idempotency_key: 'idem',
    status: 'ready_to_push',
    phase: null,
    trigger_source: 'agent_block',
    worktree_path: '/tmp/wt',
    triggered_by_user_id: 'u1',
    reviewer_verdict: 'approved',
    failure_reason: null,
    validated_head_sha: SHA,
    validated_base_sha: null,
    pr_url: null,
  }) as unknown as FinalizeRunRow;

const card = { id: 'card-1', pr_base_branch: 'main' } as KanbanCardRow;
const project = { id: 'proj-1', githubRepo: 'o/r' } as Project;

function config(
  slot: MainlineSlot = idleMainlineSlot(),
  lastLandedSha: string | null = null,
): AutopilotSessionConfig {
  return {
    durationHours: 0,
    brief: 'b',
    goal: 'g',
    escalation: 'medium',
    branch: 'main',
    startedAt: '2026-09-27T10:00:00.000Z',
    deadlineAt: null,
    status: 'running',
    cycle: 0,
    lastPushSha: null,
    target: 'mainline',
    mainline: { deployEnvironment: 'prod', landedCount: 0, slot, lastLandedSha },
  };
}

/** Deps whose session row is stateful, so slot compare-and-set works end to end. */
function harness(slot?: MainlineSlot, lastLandedSha: string | null = null) {
  const row = {
    id: 'sess-1',
    worktree_path: '/tmp/wt',
    worktree_branch: 'agent-hub/dev/session-1',
    session_mode: 'autopilot',
    autopilot_session_config: JSON.stringify(config(slot, lastLandedSha)),
  };
  const session = { ...row } as unknown as SessionRow;
  const stmts = {
    getSession: { get: vi.fn(() => ({ ...row })) },
    casSessionAutopilotConfig: {
      run: vi.fn((next: string, _id: string, expected: string | null) => {
        if (row.autopilot_session_config !== expected) return { changes: 0 };
        row.autopilot_session_config = next;
        return { changes: 1 };
      }),
    },
    updateFinalizeRunPhase: { run: vi.fn() },
    claimFinalizeRunPush: { run: vi.fn(() => ({ changes: 1 })) },
    failFinalizeRun: { run: vi.fn() },
    markFinalizeRunPushed: { run: vi.fn() },
    markFinalizeRunReadyToPush: { run: vi.fn() },
    updateSessionAskMode: { run: vi.fn() },
    updateSessionFinalizeAutomation: { run: vi.fn() },
    updateFinalizeRunPrUrl: { run: vi.fn() },
    getFinalizeRun: { get: vi.fn(() => ({ ...run(), status: 'pushing' })) },
    getFinalizePushPeerForSessionHead: { get: vi.fn(() => undefined) },
    getPushedFinalizeRunForSession: { get: vi.fn(() => undefined) },
    getLatestChecksRunForSession: { get: vi.fn(() => run()) },
    getLatestReviewRunForSession: { get: vi.fn(() => run()) },
    addMessage: { run: vi.fn() },
    touchSession: { run: vi.fn() },
    getMessageById: { get: vi.fn(() => undefined) },
    getKanbanEpic: { get: vi.fn(() => undefined) },
  };
  const deps = { stmts, broadcast: vi.fn(), config: {}, findAgent: vi.fn() };
  const lifecycle = {
    onPushed: vi.fn(),
    onReadyToPush: vi.fn(),
  };
  const storedSlot = () =>
    parseAutopilotSessionConfig(row.autopilot_session_config)!.mainline!.slot;
  const storedCount = () =>
    parseAutopilotSessionConfig(row.autopilot_session_config)!.mainline!.landedCount;
  return { deps, stmts, session, lifecycle, storedSlot, storedCount };
}

function gitWith(stdout: string, exitCode: number | null = 0) {
  return vi.fn<DefaultBranchGitRunner>(async () => ({ exitCode, stdout, stderr: '' }));
}

async function push(h: ReturnType<typeof harness>, git: DefaultBranchGitRunner) {
  const pushAndCreatePr = vi.fn();
  const outcome = await runFinalizePush({
    deps: h.deps as never,
    project,
    run: run(),
    card,
    session: h.session,
    resolveHeadSha: vi.fn().mockResolvedValue(SHA),
    resolveCurrentBranch: vi.fn().mockResolvedValue('agent-hub/dev/session-1'),
    pushAndCreatePr,
    cardLifecycle: h.lifecycle as never,
    mainlinePush: { git, guardOrigin: async () => {}, env: {} },
  });
  return { outcome, pushAndCreatePr };
}

describe('runFinalizePush: mainline session', () => {
  it('lands on the default branch: pushed with no PR, no card move, no approval mirror', async () => {
    const h = harness();
    const git = gitWith(`To origin\n \t${SHA}:refs/heads/main\ta..b\nDone\n`);
    const { outcome, pushAndCreatePr } = await push(h, git);

    expect(outcome).toEqual({ ok: true, prUrl: null });
    expect(git.mock.calls[0]![0]).toContain(`${SHA}:refs/heads/main`);
    expect(pushAndCreatePr).not.toHaveBeenCalled();
    expect(h.stmts.markFinalizeRunPushed.run).toHaveBeenCalledWith('run-1');
    expect(h.stmts.updateFinalizeRunPrUrl.run).not.toHaveBeenCalled();
    expect(h.lifecycle.onPushed).not.toHaveBeenCalled();
    expect(vi.mocked(postFinalizeApprovalReview)).not.toHaveBeenCalled();
    expect(h.storedSlot()).toMatchObject({ phase: 'landed', sha: SHA });
    expect(h.storedCount()).toBe(1);
    // Mainline sessions keep shipping; no ask-mode lock.
    expect(h.stmts.updateSessionAskMode.run).not.toHaveBeenCalled();
  });

  it('a re-push of the last landing finishes pushed with no new landing', async () => {
    const h = harness(undefined, SHA);
    const git = gitWith(`To origin\n=\t${SHA}:refs/heads/main\t[up to date]\nDone\n`);
    const { outcome } = await push(h, git);

    expect(outcome).toEqual({ ok: true, prUrl: null });
    expect(h.stmts.markFinalizeRunPushed.run).toHaveBeenCalledWith('run-1');
    expect(h.storedSlot().phase).toBe('idle');
    expect(h.storedCount()).toBe(0);
    const notices = h.stmts.addMessage.run.mock.calls.map((c) => String(c[3]));
    expect(notices).toContainEqual(expect.stringContaining('already on main'));
    expect(notices).not.toContainEqual(expect.stringContaining('deploy runs next'));
  });

  it('marks the run as pushing in this process only while the push runs', async () => {
    const h = harness();
    let release!: () => void;
    const git = vi.fn<DefaultBranchGitRunner>(async () => {
      expect(isFinalizeRunPushInProgress('run-1')).toBe(true);
      await new Promise<void>((resolve) => (release = resolve));
      return { exitCode: 0, stdout: `To origin\n \t${SHA}:refs/heads/main\ta..b\n`, stderr: '' };
    });
    const pending = push(h, git);
    await vi.waitFor(() => expect(git).toHaveBeenCalled());
    release();
    await pending;
    expect(isFinalizeRunPushInProgress('run-1')).toBe(false);
  });

  it('refuses when the slot is busy and leaves the run parked', async () => {
    const h = harness({
      ...idleMainlineSlot(),
      phase: 'deploying',
      attemptId: 'prev',
      sha: 'f'.repeat(40),
      deploymentId: 'd1',
    });
    const git = gitWith('');
    const { outcome } = await push(h, git);

    expect(outcome).toMatchObject({ ok: false, httpStatus: 409, error: 'autopilot_slot_busy' });
    expect(git).not.toHaveBeenCalled();
    expect(h.stmts.claimFinalizeRunPush.run).not.toHaveBeenCalled();
  });

  it('non-fast-forward: run fails, slot back to idle', async () => {
    const h = harness();
    const git = gitWith(`To origin\n!\t${SHA}:refs/heads/main\t[rejected] (non-fast-forward)\n`, 1);
    const { outcome } = await push(h, git);

    expect(outcome).toMatchObject({ ok: false, error: 'mainline_push_rejected' });
    expect(h.stmts.failFinalizeRun.run).toHaveBeenCalledWith(
      'failed',
      'mainline_push_rejected',
      'run-1',
    );
    expect(h.storedSlot().phase).toBe('idle');
    expect(h.stmts.markFinalizeRunPushed.run).not.toHaveBeenCalled();
  });

  it('unknown outcome: run fails non-retryably, slot uncertain', async () => {
    const h = harness();
    const { outcome } = await push(h, gitWith('', null));

    expect(outcome).toMatchObject({ ok: false, error: 'mainline_push_uncertain' });
    expect(h.stmts.failFinalizeRun.run).toHaveBeenCalledWith(
      'failed',
      'mainline_push_uncertain',
      'run-1',
    );
    expect(h.storedSlot()).toMatchObject({ phase: 'uncertain', sha: SHA });
  });

  it('slot write failure: nothing pushed, run re-parked at ready_to_push', async () => {
    const h = harness();
    h.stmts.casSessionAutopilotConfig.run.mockImplementation(() => ({ changes: 0 }));
    const git = gitWith('');
    const { outcome } = await push(h, git);

    expect(outcome).toMatchObject({ ok: false, error: 'autopilot_slot_write_failed' });
    expect(git).not.toHaveBeenCalled();
    expect(h.stmts.markFinalizeRunReadyToPush.run).toHaveBeenCalledWith(SHA, 'run-1');
    expect(h.storedSlot().phase).toBe('idle');
  });

  it('the no-run session push refuses a mainline session', async () => {
    const h = harness();
    const pushAndCreatePr = vi.fn();
    const outcome = await runSessionPushToGithub({
      deps: h.deps as never,
      project,
      session: h.session,
      card,
      pushAndCreatePr,
    });
    expect(outcome).toMatchObject({ ok: false, error: 'mainline_requires_finalize' });
    expect(pushAndCreatePr).not.toHaveBeenCalled();
  });
});
