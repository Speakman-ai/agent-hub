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
  stmts: { createSession: { run: ReturnType<typeof vi.fn> } };
  handleChat: ReturnType<typeof vi.fn>;
  broadcast: ReturnType<typeof vi.fn>;
  findAgent: ReturnType<typeof vi.fn>;
}

function makeDeps(): DepsShape {
  return {
    stmts: { createSession: { run: vi.fn() } },
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
    expect(msg.content).toContain('"event":"APPROVE"');
    expect(msg.content).toContain('REQUEST_CHANGES');
    expect(msg.content).toContain('COMMENT');
    // Reviewer should NEVER edit code or merge — those are non-negotiable.
    expect(msg.content).toMatch(/Do \*\*NOT\*\* edit code/);
    expect(msg.content).toMatch(/Do \*\*NOT\*\* merge/);
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
});
