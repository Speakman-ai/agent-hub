import { describe, it, expect, vi } from 'vitest';
import {
  buildSessionMultiSpawnArgs,
  normalizeSessionMultiEngine,
  isSessionMultiEngine,
} from './session-multi-engine.js';
import {
  buildMultiAgentTurnPlan,
  handleMultiAgentChat,
  initSessionMultiAgent,
  materializeSessionAdvisors,
  parseMentions,
} from './session-multi-agent.js';
import {
  getSessionWorktreeLockOwner,
  releaseSessionWorktreeLock,
  tryAcquireSessionWorktreeLock,
} from './session-worktree-lock.js';
import type { AppConfig, EnrichedAgent, SessionRow, Stmts } from './types.js';

describe('normalizeSessionMultiEngine / isSessionMultiEngine', () => {
  it('defaults unknown engines to claude-code', () => {
    expect(normalizeSessionMultiEngine(null)).toBe('claude-code');
    expect(normalizeSessionMultiEngine('')).toBe('claude-code');
    expect(normalizeSessionMultiEngine('gpt-5')).toBe('claude-code');
  });

  it('recognizes supported engines', () => {
    expect(isSessionMultiEngine('cursor-agent')).toBe(true);
    expect(isSessionMultiEngine('grok-cli')).toBe(true);
    expect(isSessionMultiEngine('gpt-5')).toBe(false);
  });
});

describe('buildSessionMultiSpawnArgs advisory flag', () => {
  const bins = {
    claude: '/bin/claude',
    cursor: '/bin/cursor',
    gemini: '/bin/gemini',
    codex: '/bin/codex',
    grok: '/bin/grok',
  };

  it('uses plan permission mode for advisory claude turns', () => {
    const plan = buildSessionMultiSpawnArgs({
      engine: 'claude-code',
      model: 'claude-opus-4-6',
      systemPrompt: 'sys',
      userPrompt: 'user',
      bins,
      advisory: true,
    });
    expect(plan.args).toContain('plan');
    expect(plan.bin).toBe('/bin/claude');
  });

  it('uses bypass for executor claude turns', () => {
    const plan = buildSessionMultiSpawnArgs({
      engine: 'claude-code',
      model: 'claude-opus-4-6',
      systemPrompt: 'sys',
      userPrompt: 'user',
      bins,
      advisory: false,
    });
    expect(plan.args).toContain('bypassPermissions');
  });
});

describe('buildMultiAgentTurnPlan', () => {
  const primary = {
    id: 'a1',
    name: 'Lead',
    color: '#f00',
    projectId: 'p1',
    cwd: '/tmp',
  } as EnrichedAgent;
  const advisor1 = { ...primary, id: 'a2', name: 'Reviewer' } as EnrichedAgent;
  const advisor2 = { ...primary, id: 'a3', name: 'Security' } as EnrichedAgent;

  it('starts with primary then advisor + follow-up pairs', () => {
    const plan = buildMultiAgentTurnPlan(primary, [advisor1], 'hello', 10);
    expect(plan.map((t) => t.kind)).toEqual(['executor_initial', 'advisor', 'executor_followup']);
  });

  it('respects max advisor turns', () => {
    const plan = buildMultiAgentTurnPlan(primary, [advisor1, advisor2], 'hello', 1);
    const advisorTurns = plan.filter((t) => t.kind === 'advisor');
    expect(advisorTurns).toHaveLength(1);
  });

  it('parseMentions filters advisors', () => {
    const mentions = parseMentions('hey @Security check this', [advisor1, advisor2]);
    expect(mentions.has('a3')).toBe(true);
    expect(mentions.has('a2')).toBe(false);
  });

  it('parseMentions prefers longer name when one is a prefix of another', () => {
    const reviewer = { ...primary, id: 'r1', name: 'Reviewer' } as EnrichedAgent;
    const reviewerBot = { ...primary, id: 'r2', name: 'ReviewerBot' } as EnrichedAgent;
    const mentions = parseMentions('@Reviewer please review', [reviewer, reviewerBot]);
    expect(mentions.has('r1')).toBe(true);
    expect(mentions.has('r2')).toBe(false);
  });
});

describe('materializeSessionAdvisors', () => {
  it('preserves duplicate agent instances and their independent model overrides', () => {
    const agent = {
      id: 'advisor',
      name: 'Same advisor',
      engine: 'claude-code',
      model: 'agent-default',
      projectId: 'p1',
      projectName: 'Project',
      cwd: '/tmp',
    } as EnrichedAgent;
    const rows = [
      {
        id: 'participant-1',
        session_id: 'session-1',
        agent_id: agent.id,
        model: 'model-a',
        engine: null,
        position: 0,
        added_at: '',
      },
      {
        id: 'participant-2',
        session_id: 'session-1',
        agent_id: agent.id,
        model: 'model-b',
        engine: 'codex-cli',
        position: 1,
        added_at: '',
      },
    ];

    const participants = materializeSessionAdvisors(rows, () => agent);

    expect(participants).toHaveLength(2);
    expect(participants.map((item) => item.sessionParticipantId)).toEqual([
      'participant-1',
      'participant-2',
    ]);
    expect(participants.map((item) => item.sessionModel)).toEqual(['model-a', 'model-b']);
    // Per-participant engine override is carried through so the spawn can force
    // that CLI; a null override inherits the agent's engine.
    expect(participants.map((item) => item.sessionEngine)).toEqual([null, 'codex-cli']);
  });
});

describe('multi-agent worktree lock', () => {
  it('holds the lock through the no-advisor executor handoff', async () => {
    const sessionId = 'multi-agent-lock-test';
    const session = {
      id: sessionId,
      agent_id: 'primary',
      use_worktree: 1,
    } as SessionRow;
    let currentSession = session;
    const primary = {
      id: 'primary',
      name: 'Primary',
      color: '#f00',
      projectId: 'p1',
      cwd: '/tmp',
    } as EnrichedAgent;
    let releaseExecutor!: () => void;
    let resolveExecutorStarted!: () => void;
    const executorStarted = new Promise<void>((resolve) => {
      resolveExecutorStarted = resolve;
    });
    const runExecutorTurn = vi.fn(async (_ws, msg) => {
      expect(msg._multiAgentInternal).toBe(true);
      resolveExecutorStarted();
      await new Promise<void>((resolve) => {
        releaseExecutor = resolve;
      });
    });
    const getSession = vi.fn(() => currentSession);

    initSessionMultiAgent({
      stmts: {
        getSession: { get: getSession },
        getSessionAgents: { all: vi.fn(() => []) },
      } as unknown as Stmts,
      broadcast: vi.fn(),
      getEnrichedAgent: vi.fn(() => primary),
      buildEnrichedPrompt: vi.fn(() => ''),
      getClaudeBin: vi.fn(() => '/bin/claude'),
      getCursorBin: vi.fn(() => '/bin/cursor'),
      getGeminiBin: vi.fn(() => '/bin/gemini'),
      getCodexBin: vi.fn(() => '/bin/codex'),
      getGrokBin: vi.fn(() => '/bin/grok'),
      getConfig: vi.fn(() => ({}) as AppConfig),
      getMaxQueueSize: vi.fn(() => 10),
      runExecutorTurn,
    });

    expect(tryAcquireSessionWorktreeLock(sessionId, 'turn-start')).toBe(true);
    const execution = handleMultiAgentChat(null, {
      type: 'chat',
      agentId: 'primary',
      sessionId,
      content: 'start',
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(runExecutorTurn).not.toHaveBeenCalled();
    currentSession = { ...session, worktree_branch: 'feature/switched' };
    releaseSessionWorktreeLock(sessionId, 'turn-start');
    await executorStarted;
    expect(getSession).toHaveBeenCalledTimes(2);
    expect(getSessionWorktreeLockOwner(sessionId)).toBe('multi-agent-round');

    releaseExecutor();
    await execution;
    expect(getSessionWorktreeLockOwner(sessionId)).toBeNull();
    expect(runExecutorTurn).toHaveBeenCalledTimes(1);
  });
});
