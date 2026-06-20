import '../test/setup.js';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import { parseAutoReviewSessionTitle, finalizeAutoReviewSession } from './auto-review-lifecycle.js';
import type { Agent, BroadcastFn, Project, Stmts } from '../types.js';

const findAgent = vi.fn();

vi.mock('../project-model.js', () => ({
  findAgent: (...args: unknown[]) => findAgent(...args),
}));

describe('parseAutoReviewSessionTitle', () => {
  it('parses external-push auto-review session titles', () => {
    expect(parseAutoReviewSessionTitle('[Review PR #28] external push @ bb98fd1c')).toEqual({
      prNumber: 28,
    });
  });

  it('parses manually-requested auto-review session titles', () => {
    // Regression: the manual "Request review" press names the session
    // `requested @ <sha>`; it must be archivable too, or it lingers on the
    // dashboard forever (support ticket cabb0074).
    expect(parseAutoReviewSessionTitle('[Review PR #28] requested @ bb98fd1c')).toEqual({
      prNumber: 28,
    });
  });

  it('rejects resolve/autofix titles', () => {
    expect(parseAutoReviewSessionTitle('[Resolve PR #28]')).toBeNull();
    expect(parseAutoReviewSessionTitle('normal session')).toBeNull();
  });
});

describe('finalizeAutoReviewSession', () => {
  const projectId = 'proj-auto-review';
  const agentId = 'agent-reviewer';
  const sessionId = uuidv4();
  const sessionName = '[Review PR #3] external push @ deadbeef';

  let stmts: Stmts;
  let broadcast: ReturnType<typeof vi.fn>;

  const reviewerLookup = {
    project: { id: projectId, gitHost: 'agenthub', name: projectId } as Project,
    agent: { id: agentId, name: 'agent-hub Reviewer', role: 'reviewer' } as Agent,
  };

  beforeEach(() => {
    findAgent.mockReturnValue(reviewerLookup);

    broadcast = vi.fn();
    stmts = {
      getSession: { get: vi.fn(() => ({ deleted_at: null })) },
      getPullRequestByNumber: { get: vi.fn(() => ({ status: 'open' })) },
      insertPullRequestReview: { run: vi.fn() },
      getBackgroundTaskBySession: {
        get: vi.fn(() => ({ id: 'task-1', status: 'running' })),
      },
      updateBackgroundTaskStatus: { run: vi.fn() },
      softDeleteSession: { run: vi.fn() },
    } as unknown as Stmts;
  });

  it('archives the session after a successful turn', () => {
    finalizeAutoReviewSession(
      { stmts, broadcast: broadcast as unknown as BroadcastFn },
      { sessionId, agentId, sessionName },
    );

    expect(stmts.insertPullRequestReview?.run).not.toHaveBeenCalled();
    expect(stmts.updateBackgroundTaskStatus?.run).toHaveBeenCalledWith('done', 'task-1');
    expect(stmts.softDeleteSession?.run).toHaveBeenCalledWith(sessionId);
    expect(broadcast).toHaveBeenCalledWith({ type: 'session_deleted', sessionId });
  });

  it('archives a manually-requested review session after a successful turn', () => {
    // Regression for support ticket cabb0074: `requested @ <sha>` sessions used
    // to slip past the lifecycle regex and pile up on the dashboard.
    finalizeAutoReviewSession(
      { stmts, broadcast: broadcast as unknown as BroadcastFn },
      { sessionId, agentId, sessionName: '[Review PR #3] requested @ deadbeef' },
    );

    expect(stmts.softDeleteSession?.run).toHaveBeenCalledWith(sessionId);
    expect(broadcast).toHaveBeenCalledWith({ type: 'session_deleted', sessionId });
  });

  it('posts a commented review on failure, then archives', () => {
    finalizeAutoReviewSession(
      { stmts, broadcast: broadcast as unknown as BroadcastFn },
      { sessionId, agentId, sessionName, error: 'codex exited 1' },
    );

    expect(stmts.insertPullRequestReview?.run).toHaveBeenCalledWith(
      expect.any(String),
      projectId,
      3,
      'agent-hub Reviewer',
      'commented',
      expect.stringContaining('codex exited 1'),
      expect.any(Number),
    );
    expect(stmts.updateBackgroundTaskStatus?.run).toHaveBeenCalledWith('error', 'task-1');
    expect(stmts.softDeleteSession?.run).toHaveBeenCalledWith(sessionId);
  });

  it('no-ops for unrelated session titles', () => {
    finalizeAutoReviewSession(
      { stmts, broadcast: broadcast as unknown as BroadcastFn },
      { sessionId, agentId, sessionName: 'regular chat' },
    );
    expect(stmts.softDeleteSession.run).not.toHaveBeenCalled();
  });

  it('does not archive a non-reviewer session matching the title pattern', () => {
    // A manually renamed non-reviewer session must not be swept up: cleanup is
    // part of the reviewer lifecycle contract, keyed on agent.role.
    findAgent.mockReturnValue({
      project: reviewerLookup.project,
      agent: { id: agentId, name: 'Some Dev', role: 'dev' } as Agent,
    });

    finalizeAutoReviewSession(
      { stmts, broadcast: broadcast as unknown as BroadcastFn },
      { sessionId, agentId, sessionName },
    );

    expect(stmts.softDeleteSession.run).not.toHaveBeenCalled();
    expect(stmts.updateBackgroundTaskStatus.run).not.toHaveBeenCalled();
    expect(stmts.insertPullRequestReview.run).not.toHaveBeenCalled();
  });
});

describe('chat turn-end auto-review finalization ordering', () => {
  it('defers finalization while a ReAct continuation is pending and runs it before the generic bg-task completion', async () => {
    const { readFile } = await import('fs/promises');
    const src = await readFile(new URL('../chat.ts', import.meta.url), 'utf8');

    // Only inspect the turn-end region: between where shouldAutoContinue is
    // resolved and the auto-continuation branch that re-enters handleChat.
    const resolveIdx = src.indexOf('shouldAutoContinue = budgetResult.ok');
    const autoBranchIdx = src.indexOf('if (shouldAutoContinue) {');
    expect(resolveIdx).toBeGreaterThan(-1);
    expect(autoBranchIdx).toBeGreaterThan(resolveIdx);
    const region = src.slice(resolveIdx, autoBranchIdx);

    const finalizeIdx = region.indexOf('maybeFinalizeAutoReviewSession(');
    expect(finalizeIdx).toBeGreaterThan(-1);

    // Blocker [5/10]: the turn-end finalize must be guarded by !shouldAutoContinue
    // so a pending continuation does not archive the session before its verdict.
    const guardIdx = region.lastIndexOf('if (!shouldAutoContinue) {', finalizeIdx);
    expect(guardIdx).toBeGreaterThan(-1);
    expect(guardIdx).toBeLessThan(finalizeIdx);

    // Note [3/10]: finalize owns bg-task completion for these sessions, so it must
    // run before the generic `done` completion block claims the task.
    const genericDoneIdx = region.indexOf("S.updateBackgroundTaskStatus.run('done'");
    expect(genericDoneIdx).toBeGreaterThan(-1);
    expect(finalizeIdx).toBeLessThan(genericDoneIdx);
  });
});
