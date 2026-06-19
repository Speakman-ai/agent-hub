/**
 * Placement regression for the crash-loop resume cap reset.
 *
 * The reset of `resume_attempts` must happen only when a fresh turn is actually
 * committed/spawned — past validation and the session-busy / duplicate-send
 * enqueue guard. An earlier version reset at the top of `handleChat`, so a
 * duplicate send while another task was active (e.g. mid auto-resume) wiped the
 * counter even though that send was merely enqueued, defeating the cap if the
 * server then restarted during the in-flight auto-resume.
 *
 * Uses the real DB + a mocked CLI (`/bin/true`) via createChatHandler, mirroring
 * chat-interrupt-existing-queued.test.ts. No real CLI is spawned.
 */
import './test/setup.js';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { randomUUID } from 'crypto';
import { getStmts } from './db.js';
import createChatHandler, { type ChatHandlerDeps } from './chat.js';
import type { ChildProcess } from 'child_process';
import type { Agent, EnrichedAgent, Project } from './types.js';

vi.mock('./per-user-cli-spawn.js', () => ({
  EngineAuthRequiredError: class EngineAuthRequiredError extends Error {},
  resolveSessionCliSpawnEnv: vi.fn(() => ({})),
}));

function stubChatDeps(
  agentId: string,
  activeProcesses: Map<string, ChildProcess>,
): ReturnType<typeof createChatHandler> {
  const agent = { id: agentId, name: 'Reset test agent', engine: 'claude-code' } as Agent;
  const project = {
    id: 'proj-reset',
    name: 'Reset test',
    cwd: '/tmp',
    ahw: '/tmp',
    agents: [],
  } as Project;
  const enriched = {
    id: agentId,
    name: 'Reset test agent',
    engine: 'claude-code',
    projectId: 'proj-reset',
    cwd: '/tmp',
    ahw: '/tmp',
    workspace: '/tmp',
  } as EnrichedAgent;

  const deps: ChatHandlerDeps = {
    broadcast: () => {},
    createCursorChat: undefined,
    findAgent: (id) => (id === agentId ? { project, agent } : null),
    getEnrichedAgent: (id) => (id === agentId ? enriched : null),
    activeProcesses,
    activeDelegationSessions: new Set(),
    autonomousProjects: new Set(),
    getClaudeBin: () => '/bin/true',
    getCursorBin: () => '/bin/true',
    getGeminiBin: () => '/bin/true',
    getCodexBin: () => '/bin/true',
    getGrokBin: () => '/bin/true',
    uploadsDir: '/tmp',
    resolveSlashSkill: vi.fn(),
    ensureWorktree: vi.fn(async () => '/tmp'),
    drainQueue: vi.fn(),
    handleDelegation: vi.fn(async () => []),
    handleDelegationCancel: vi.fn(),
    synthesizeResults: vi.fn(),
    parseDelegateBlock: vi.fn(),
    autoCommitAndPR: vi.fn(async () => undefined),
    tryAutonomousDispatch: vi.fn(),
  };
  return createChatHandler(deps);
}

function seedSession(suffix: string, resumeAttempts: number) {
  const prefix = `reset-${randomUUID().slice(0, 8)}`;
  const agentId = `${prefix}-agent-${suffix}`;
  const sessionId = `${prefix}-sess-${suffix}`;
  const stmts = getStmts();
  stmts.createSession.run(
    sessionId,
    agentId,
    'reset test',
    'claude-code',
    'claude-opus-4-8',
    0,
    0,
    1,
  );
  for (let i = 0; i < resumeAttempts; i++) stmts.incrementSessionResumeAttempts.run(sessionId);
  return { agentId, sessionId };
}

const attemptsOf = (sessionId: string): number =>
  (getStmts().getSession.get(sessionId) as { resume_attempts: number }).resume_attempts;

describe('handleChat — resume_attempts reset placement', () => {
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('does NOT reset when the session is busy (duplicate send is enqueued, not spawned)', async () => {
    const { agentId, sessionId } = seedSession('busy', 3);
    // Active process present -> session is busy.
    const activeProcesses = new Map<string, ChildProcess>([
      [sessionId, { pid: 4242 } as ChildProcess],
    ]);
    const { handleChat } = stubChatDeps(agentId, activeProcesses);

    expect(attemptsOf(sessionId)).toBe(3);

    // Fresh, non-_fromQueue human send while busy -> enqueued before the
    // spawn-commit reset is reached. The cap must survive.
    await handleChat(null, { type: 'chat', agentId, sessionId, content: 'duplicate while busy' });

    expect(attemptsOf(sessionId)).toBe(3);
    // And it really was enqueued (proving we took the busy short-circuit).
    expect(getStmts().getQueuedMessages.all(sessionId).length).toBeGreaterThan(0);
  });

  it('DOES reset when a fresh turn is committed on an idle session', async () => {
    const { agentId, sessionId } = seedSession('idle', 3);
    const { handleChat } = stubChatDeps(agentId, new Map());

    expect(attemptsOf(sessionId)).toBe(3);

    await handleChat(null, { type: 'chat', agentId, sessionId, content: 'fresh human turn' });

    expect(attemptsOf(sessionId)).toBe(0);
  });

  it('does NOT reset when the committed turn is an automatic crash-resume', async () => {
    const { agentId, sessionId } = seedSession('autoresume', 2);
    const { handleChat } = stubChatDeps(agentId, new Map());

    expect(attemptsOf(sessionId)).toBe(2);

    await handleChat(null, {
      type: 'chat',
      agentId,
      sessionId,
      content: 'auto-resume after restart',
      _autoResume: true,
    });

    expect(attemptsOf(sessionId)).toBe(2);
  });
});
