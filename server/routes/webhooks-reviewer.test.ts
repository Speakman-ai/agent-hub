import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { dispatchReviewerForPR, _clearReviewerDebounce } from './webhooks.js';
import type { Project } from '../types.js';

// `dispatchReviewerForPR` is the unified trigger surface for review:
// every `pull_request.opened` / `pull_request.synchronize` webhook routes
// here, regardless of autonomous mode. These tests pin its core contract.

function makeProject(reviewerRole: 'reviewer' | 'lead' | null = 'reviewer'): Project {
  const agents = reviewerRole
    ? [
        {
          id: 'reviewer-1',
          name: 'PR Reviewer',
          role: reviewerRole,
          engine: 'claude-code',
          model: 'claude-sonnet-4-20250514',
        },
      ]
    : [];
  return {
    id: 'proj-1',
    name: 'Test Project',
    cwd: '/tmp',
    ahw: '',
    agents,
  } as unknown as Project;
}

interface DepsShape {
  stmts: {
    createSession: { run: ReturnType<typeof vi.fn> };
    getSession: { get: ReturnType<typeof vi.fn> };
  };
  handleChat: ReturnType<typeof vi.fn>;
  broadcast: ReturnType<typeof vi.fn>;
  findAgent: ReturnType<typeof vi.fn>;
}

function makeDeps(): DepsShape {
  const createSessionRun = vi.fn();
  const getSessionGet = vi.fn((sessionId: string) => {
    const call = createSessionRun.mock.calls.find((c: unknown[]) => c[0] === sessionId);
    if (!call) return undefined;
    return {
      id: sessionId,
      agent_id: call[1],
      name: call[2],
      engine: call[3],
      model: call[4],
      engine_session_id: null,
      use_worktree: 1,
      worktree_path: null,
      worktree_branch: null,
      git_worktree_detected: null,
      changes_ready: null,
      stale_pr_notified_at: null,
      ask_mode: 0,
      wiki_hybrid_rag_consumed: 0,
      cron_id: null,
      created_at: '2020-01-01T00:00:00.000Z',
      updated_at: '2020-01-01T00:00:00.000Z',
      deleted_at: null,
    };
  });
  return {
    stmts: { createSession: { run: createSessionRun }, getSession: { get: getSessionGet } },
    handleChat: vi.fn(() => Promise.resolve()),
    broadcast: vi.fn(),
    findAgent: vi.fn(() => null),
  };
}

const OPTS = {
  prUrl: 'https://github.com/owner/repo/pull/42',
  prNumber: 42,
  prTitle: 'Add feature X',
  repoFullName: 'owner/repo',
  reason: 'opened' as const,
};

beforeEach(() => {
  vi.useFakeTimers();
  _clearReviewerDebounce();
});

afterEach(() => {
  _clearReviewerDebounce();
  vi.useRealTimers();
});

describe('dispatchReviewerForPR — gating', () => {
  it('returns false and does NOT dispatch when project has no reviewer agent', () => {
    const deps = makeDeps();
    const project = makeProject(null);

    const scheduled = dispatchReviewerForPR(deps as never, project, OPTS);

    expect(scheduled).toBe(false);
    vi.runAllTimers();
    expect(deps.handleChat).not.toHaveBeenCalled();
    expect(deps.stmts.createSession.run).not.toHaveBeenCalled();
  });

  it('returns false when only non-reviewer-role agents exist', () => {
    const deps = makeDeps();
    const project = makeProject('lead');

    const scheduled = dispatchReviewerForPR(deps as never, project, OPTS);

    expect(scheduled).toBe(false);
    vi.runAllTimers();
    expect(deps.handleChat).not.toHaveBeenCalled();
  });

  it('schedules a debounced dispatch when a reviewer agent exists', () => {
    const deps = makeDeps();
    const project = makeProject('reviewer');

    const scheduled = dispatchReviewerForPR(deps as never, project, OPTS);

    expect(scheduled).toBe(true);
    // Nothing fires before the debounce window elapses.
    expect(deps.handleChat).not.toHaveBeenCalled();
    vi.runAllTimers();
    expect(deps.handleChat).toHaveBeenCalledTimes(1);
    expect(deps.stmts.createSession.run).toHaveBeenCalledTimes(1);
    expect(deps.broadcast).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'session_created',
        agentId: 'reviewer-1',
        session: expect.objectContaining({ agent_id: 'reviewer-1' }),
      }),
    );
  });
});

describe('dispatchReviewerForPR — debounce', () => {
  it('coalesces multiple rapid synchronizes for the same PR into one dispatch', () => {
    const deps = makeDeps();
    const project = makeProject('reviewer');

    dispatchReviewerForPR(deps as never, project, OPTS);
    dispatchReviewerForPR(deps as never, project, { ...OPTS, reason: 'synchronize' });
    dispatchReviewerForPR(deps as never, project, { ...OPTS, reason: 'synchronize' });

    vi.runAllTimers();

    expect(deps.handleChat).toHaveBeenCalledTimes(1);
    // The latest call wins — the prompt should reflect "synchronize"
    const callArgs = deps.handleChat.mock.calls[0]?.[1] as { content: string };
    expect(callArgs.content).toContain('New commits were pushed');
  });

  it('treats different PR numbers as independent debounce keys', () => {
    const deps = makeDeps();
    const project = makeProject('reviewer');

    dispatchReviewerForPR(deps as never, project, OPTS);
    dispatchReviewerForPR(deps as never, project, { ...OPTS, prNumber: 43 });

    vi.runAllTimers();

    expect(deps.handleChat).toHaveBeenCalledTimes(2);
  });
});

describe('dispatchReviewerForPR — prompt content', () => {
  it('includes PR url, number, repo, and the App-backed review endpoint in the prompt', () => {
    const deps = makeDeps();
    const project = makeProject('reviewer');

    dispatchReviewerForPR(deps as never, project, OPTS);
    vi.runAllTimers();

    const msg = deps.handleChat.mock.calls[0]?.[1] as { content: string };
    expect(msg.content).toContain('https://github.com/owner/repo/pull/42');
    expect(msg.content).toContain('owner/repo');
    expect(msg.content).toContain('PR Review Request (opened)');
    // The reviewer must route reviews through Agent Hub's App-backed endpoint so
    // self-approval works (App identity ≠ PR author identity). Using `gh pr review`
    // directly would submit as the CLI user and silently downgrade APPROVE → COMMENTED.
    expect(msg.content).toContain('/api/pr/review');
    // All three events must be presented — the curl example must NOT hardcode one,
    // or the reviewer will anchor on that event as the default (historically APPROVE,
    // which is how the "always approve with non-blocking comments" bias was produced).
    expect(msg.content).toContain('"event":"<EVENT>"');
    expect(msg.content).not.toContain('"event":"APPROVE"');
    expect(msg.content).toContain('APPROVE');
    expect(msg.content).toContain('REQUEST_CHANGES');
    expect(msg.content).toContain('COMMENT');
    // Reviewer should NEVER edit code or merge — those are non-negotiable.
    expect(msg.content).toMatch(/Do \*\*NOT\*\* edit code/);
    expect(msg.content).toMatch(/Do \*\*NOT\*\* merge/);
  });

  it('presents a balanced decision tree that prevents both APPROVE-bias and COMMENT-bias', () => {
    const deps = makeDeps();
    const project = makeProject('reviewer');

    dispatchReviewerForPR(deps as never, project, OPTS);
    vi.runAllTimers();

    const msg = deps.handleChat.mock.calls[0]?.[1] as { content: string };

    // Must be a decision TREE (walk in order, first match), not a flat rubric —
    // the flat rubric lets the reviewer pick whichever label feels comfortable,
    // which is how we ended up defaulting to COMMENT for everything.
    expect(msg.content).toMatch(/decision tree/i);

    // The blocking vs. non-blocking distinction is what the tree branches on.
    // If this disappears the reviewer falls back to the old ambiguous
    // nit/substantive classification and starts hedging again.
    expect(msg.content).toMatch(/blocking/i);
    expect(msg.content).toMatch(/non-blocking/i);

    // Load-bearing: APPROVE must be described as compatible with non-blocking
    // feedback. The old wording ("zero substantive feedback") caused the
    // COMMENT over-correction — reviewers always have *some* suggestion, so
    // APPROVE became unreachable in practice.
    expect(msg.content).toMatch(/mergeable as-is/i);

    // Both anti-patterns must be explicitly named so neither bias recurs:
    //   don't over-correct → defaulting non-blocking reviews to COMMENT
    //   don't rubber-stamp → burying a real blocker in an APPROVE body
    expect(msg.content).toMatch(/don't over-correct/i);
    expect(msg.content).toMatch(/don't rubber-stamp/i);

    // COMMENT must be scoped to its narrow, genuine use (undecided / design
    // question), not "the default for non-nit feedback" as the prior prompt
    // had it. Catch positive-framing phrasings that would re-introduce the bias.
    // We intentionally use a tight proximity (≤40 non-period chars between the
    // word "default" and "COMMENT") so discouragement phrasing like
    // "Defaulting … to COMMENT destroys the signal" elsewhere in the prompt
    // doesn't trip the check.
    expect(msg.content).not.toMatch(/\bdefault\b[^.]{0,40}\bCOMMENT\b/i);
    expect(msg.content).not.toMatch(/\bCOMMENT\b[^.]{0,40}\bis the default\b/i);

    // All three events must still be presented (redundant with the earlier
    // test but worth asserting alongside the tree wording).
    expect(msg.content).toContain('APPROVE');
    expect(msg.content).toContain('REQUEST_CHANGES');
    expect(msg.content).toContain('COMMENT');
  });

  it('instructs the reviewer to score every finding 1–10 and block on >3', () => {
    // Regression guard for the severity-scoring rubric. Before this was
    // introduced, the reviewer would classify issues as "blocking" vs
    // "non-blocking" based on feel, which let real issues slip under APPROVE
    // because they weren't as bad as a showstopper. The 1–10 rubric plus the
    // hard ">3 → REQUEST_CHANGES" rule removes that hedge.
    const deps = makeDeps();
    const project = makeProject('reviewer');

    dispatchReviewerForPR(deps as never, project, OPTS);
    vi.runAllTimers();

    const msg = deps.handleChat.mock.calls[0]?.[1] as { content: string };

    // The rubric must be presented as a 1–10 scale.
    expect(msg.content).toMatch(/severity (score|rubric)/i);
    expect(msg.content).toMatch(/1\s*[–-]\s*10/);

    // All six rubric bands must be present so the reviewer has calibration
    // anchors rather than picking a number from thin air.
    expect(msg.content).toMatch(/\b1\s*[–-]\s*2\b/);
    expect(msg.content).toMatch(/\b3\b/);
    expect(msg.content).toMatch(/\b4\s*[–-]\s*5\b/);
    expect(msg.content).toMatch(/\b6\s*[–-]\s*7\b/);
    expect(msg.content).toMatch(/\b8\s*[–-]\s*9\b/);
    expect(msg.content).toMatch(/\b10\b/);

    // The hard threshold: anything >3 is blocking. This wording is
    // load-bearing — if it drifts to ">=5" or "major issues" the reviewer
    // regains wiggle room and the rubric loses its teeth.
    expect(msg.content).toMatch(/>\s*3/);
    expect(msg.content).toMatch(/REQUEST_CHANGES/);

    // The tie-break rule (round up, not down) prevents under-scoring as
    // an escape hatch from the >3 rule.
    expect(msg.content).toMatch(/round up/i);

    // The decision tree itself must branch on the score, not on vibes.
    expect(msg.content).toMatch(/score\b[^.]*\b(greater than|>)\s*3/i);
  });

  it('uses synchronize wording when reason is synchronize', () => {
    const deps = makeDeps();
    const project = makeProject('reviewer');

    dispatchReviewerForPR(deps as never, project, { ...OPTS, reason: 'synchronize' });
    vi.runAllTimers();

    const msg = deps.handleChat.mock.calls[0]?.[1] as { content: string };
    expect(msg.content).toContain('PR Review Request (synchronize)');
    expect(msg.content).toContain('New commits were pushed');
  });
});

describe('dispatchReviewerForPR — session bookkeeping', () => {
  it('creates a session whose name is prefixed with "Review: PR #"', () => {
    const deps = makeDeps();
    const project = makeProject('reviewer');

    dispatchReviewerForPR(deps as never, project, OPTS);
    vi.runAllTimers();

    expect(deps.stmts.createSession.run).toHaveBeenCalledTimes(1);
    const sessionArgs = deps.stmts.createSession.run.mock.calls[0] || [];
    // [sessionId, agentId, name, engine, model, autoCommit, isMonitor]
    expect(sessionArgs[1]).toBe('reviewer-1');
    expect(sessionArgs[2]).toMatch(/^Review: PR #42 /);
  });

  it('uses githubWorkflow.reviewerModel over the reviewer agent model when set', () => {
    const deps = makeDeps();
    const project = {
      ...makeProject('reviewer'),
      githubWorkflow: { reviewerModel: 'override-model-id' },
    };

    dispatchReviewerForPR(deps as never, project, OPTS);
    vi.runAllTimers();

    const sessionArgs = deps.stmts.createSession.run.mock.calls[0] || [];
    expect(sessionArgs[4]).toBe('override-model-id');
  });
});
