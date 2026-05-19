import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  dispatchReviewerForPR,
  _clearReviewerDebounce,
  buildReviewerDispatchPrompt,
} from './webhooks.js';
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

  it('returns false in workflow mode even when a reviewer agent exists', () => {
    const deps = makeDeps();
    const project = { ...makeProject('reviewer'), mode: 'workflow' as const };

    const scheduled = dispatchReviewerForPR(deps as never, project, OPTS);

    expect(scheduled).toBe(false);
    vi.runAllTimers();
    expect(deps.handleChat).not.toHaveBeenCalled();
    expect(deps.stmts.createSession.run).not.toHaveBeenCalled();
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
    // Only APPROVE and REQUEST_CHANGES are allowed at POST /api/pr/review.
    expect(msg.content).toContain('"event":"<EVENT>"');
    expect(msg.content).not.toContain('"event":"APPROVE"');
    expect(msg.content).toContain('APPROVE');
    expect(msg.content).toContain('REQUEST_CHANGES');
    expect(msg.content).toMatch(/rejects.*COMMENT|Never send.*COMMENT|returns 400/i);
    // Reviewer should NEVER edit code or merge — those are non-negotiable.
    expect(msg.content).toMatch(/Do \*\*NOT\*\* edit code/);
    expect(msg.content).toMatch(/Do \*\*NOT\*\* merge/);
  });

  it('presents a two-outcome decision tree (APPROVE vs REQUEST_CHANGES; COMMENT rejected at API)', () => {
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

    expect(msg.content).toMatch(/don't rubber-stamp/i);
    expect(msg.content).toMatch(/Never send.*COMMENT|rejects.*COMMENT|returns 400/i);
    expect(msg.content).not.toMatch(/3\.\s+\*\*Only if you genuinely cannot decide\*\*/);

    expect(msg.content).toContain('APPROVE');
    expect(msg.content).toContain('REQUEST_CHANGES');
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
    // After a push, prior APPROVE may be stale; COMMENT + "approved" prose does not unblock merge.
    expect(msg.content).toMatch(/dismiss stale|stale reviews/i);
    expect(msg.content).toMatch(/COMMENT[\s\S]{0,200}never/i);
  });
});

describe('buildReviewerDispatchPrompt — formal review forcing on synchronize', () => {
  // These tests pin the #1009 regression: after an autofix push fires
  // `pull_request.synchronize`, the reviewer woke up correctly but dropped a
  // free-form issue comment ("Resolved the blocking item…") instead of POSTing
  // a fresh formal review. The prior CHANGES_REQUESTED stayed canonical, so
  // the PR stayed BLOCKED. The synchronize block must explicitly forbid
  // comment-only responses and require POST /api/pr/review with a formal
  // event on every synchronize re-run.

  it('on synchronize, requires a formal POST /api/pr/review (not a comment-only response)', () => {
    const prompt = buildReviewerDispatchPrompt({
      prUrl: 'https://github.com/owner/repo/pull/42',
      prNumber: 42,
      prTitle: 'Add feature X',
      repoFullName: 'owner/repo',
      reason: 'synchronize',
    });

    // The block must shout MANDATORY in the heading so the language ranks
    // high in the agent's attention. Heading-level forcing language is the
    // strongest anti-drift signal — burying this in a bullet didn't work.
    expect(prompt).toMatch(/FORMAL REVIEW IS MANDATORY/);

    // The endpoint must be named with the verb so the agent knows what to
    // call. `/api/pr/review` alone appears in other prompts; pairing it
    // with `POST` here is the discriminator.
    expect(prompt).toMatch(/POST\s+\/api\/pr\/review|POST\s+`?\/api\/pr\/review/);
  });

  it('on synchronize, explicitly names the failure modes that do NOT count as a re-review', () => {
    const prompt = buildReviewerDispatchPrompt({
      prUrl: 'https://github.com/owner/repo/pull/42',
      prNumber: 42,
      prTitle: 'Add feature X',
      repoFullName: 'owner/repo',
      reason: 'synchronize',
    });

    // The #1009 failure was a `gh pr comment` issue comment. Naming the
    // tool is what makes the rule sticky — generic "comment vs review"
    // wording lets the agent reason it's an exception.
    expect(prompt).toMatch(/gh pr comment|issue comment/i);

    // Adjacent failure modes that share the same blast radius:
    //   - inline review comments (pulls/.../comments)
    //   - threaded replies
    //   - editing/deleting the prior review
    // Listing them prevents the "well, MY comment was different because…"
    // self-justification loop.
    expect(prompt).toMatch(/inline (review )?comment/i);
    expect(prompt).toMatch(/threaded repl(y|ies)/i);

    // The block must also explicitly reference the #1009 regression so this
    // wording can't drift back to a softer form by accident in future edits.
    // The PR number is the load-bearing anchor — readers can find this PR's
    // postmortem and see the cost of dropping the rule.
    expect(prompt).toMatch(/#?1009/);
  });

  it('on synchronize, requires the reviewer to self-check that POST /api/pr/review was called before ending', () => {
    const prompt = buildReviewerDispatchPrompt({
      prUrl: 'https://github.com/owner/repo/pull/42',
      prNumber: 42,
      prTitle: 'Add feature X',
      repoFullName: 'owner/repo',
      reason: 'synchronize',
    });

    // A pre-exit self-check is the secondary guardrail. If the agent reads
    // past the heading, the self-check forces it back to the contract right
    // before it stops. Without this, prompt-tightening alone is one drift
    // away from re-introducing the gap.
    expect(prompt).toMatch(/self-check|self check/i);
    expect(prompt).toMatch(/before (you )?(end|stop)/i);
  });

  it('does NOT include the formal-review forcing block on the opened path', () => {
    // The forcing block is scoped to synchronize because that's where the
    // #1009 regression lives — a brand-new `opened` event has no prior
    // CHANGES_REQUESTED to leave stale, so the regular decision tree is
    // sufficient. If we ever generalize this, update the test alongside the
    // prompt so the scope change is intentional.
    const prompt = buildReviewerDispatchPrompt({
      prUrl: 'https://github.com/owner/repo/pull/42',
      prNumber: 42,
      prTitle: 'Add feature X',
      repoFullName: 'owner/repo',
      reason: 'opened',
    });

    expect(prompt).not.toMatch(/FORMAL REVIEW IS MANDATORY/);
    // Regression-pin: the #1009 anchor lives inside the synchronize block;
    // it must not bleed into the opened-event prompt.
    expect(prompt).not.toMatch(/#?1009/);
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
