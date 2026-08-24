/**
 * Handler-level guard: a synthetic turn (commit nudge / ship trigger /
 * auto-continuation) sends a CLI-only prompt with `_skipUserMessagePersist`.
 * chat.ts must NOT run the auto title-rename on such a turn, or the nudge text
 * "You left uncommitted changes on '<branch>'…" hijacks the session name (and
 * the linked card / PR title derived from it). This exercises the real
 * `handleChat` closure end-to-end so it fails if the `isRealUserTitleTurn`
 * guard is removed — the isolated `session-title.test.ts` unit test cannot
 * catch a regression in how chat.ts wires that guard.
 */
import './test/setup.js';
import { describe, it, expect, vi } from 'vitest';
import { randomUUID } from 'crypto';
import { getStmts } from './db.js';
import createChatHandler, { type ChatHandlerDeps } from './chat.js';
import type { ActiveChatProcess } from './active-chat-process.js';
import { buildCommitNudgeCliPrompt } from './local-commit-reminder.js';
import type { Agent, EnrichedAgent, Project, SessionRow } from './types.js';

vi.mock('./per-user-cli-spawn.js', () => ({
  EngineAuthRequiredError: class EngineAuthRequiredError extends Error {},
  resolveSessionCliSpawnEnv: vi.fn(() => ({})),
}));

function stubChatDeps(agentId: string): ReturnType<typeof createChatHandler>['handleChat'] {
  const agent = { id: agentId, name: 'Title guard agent', engine: 'claude-code' } as Agent;
  const project = {
    id: 'proj-title-guard',
    name: 'Title guard project',
    cwd: '/tmp',
    ahw: '/tmp',
    agents: [],
  } as Project;
  const enriched = {
    id: agentId,
    name: 'Title guard agent',
    engine: 'claude-code',
    projectId: 'proj-title-guard',
    cwd: '/tmp',
    ahw: '/tmp',
    workspace: '/tmp',
  } as EnrichedAgent;

  const deps: ChatHandlerDeps = {
    broadcast: () => {},
    createCursorChat: undefined,
    findAgent: (id) => (id === agentId ? { project, agent } : null),
    getEnrichedAgent: (id) => (id === agentId ? enriched : null),
    activeProcesses: new Map<string, ActiveChatProcess>(),
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
    autoCommitAndPR: vi.fn(async () => undefined),
    tryAutonomousDispatch: vi.fn(),
  };

  return createChatHandler(deps).handleChat;
}

/** Seed a session whose title is auto-owned so the rename path is reachable. */
function seedAutoTitledSession(suffix: string, initialName: string) {
  const agentId = `title-guard-agent-${suffix}`;
  const sessionId = `title-guard-sess-${suffix}`;
  const stmts = getStmts();
  stmts.createSession.run(
    sessionId,
    agentId,
    initialName,
    'claude-code',
    'claude-opus-4-8',
    0,
    0,
    1,
  );
  // Mark the title auto-owned; otherwise pickTurnSessionTitle refuses to rename.
  stmts.updateSessionNameWithTitleSource.run(initialName, 'auto', sessionId);
  return { agentId, sessionId };
}

function sessionName(sessionId: string): string {
  return (getStmts().getSession.get(sessionId) as SessionRow).name;
}

describe('handleChat — synthetic turns do not hijack the session title', () => {
  const prefix = randomUUID().slice(0, 8);

  it('does not rename the session on a commit-nudge turn (_skipUserMessagePersist)', async () => {
    const initialName = 'Add webhook retry backoff';
    const { agentId, sessionId } = seedAutoTitledSession(`${prefix}-nudge`, initialName);
    const handleChat = stubChatDeps(agentId);

    await handleChat(null, {
      type: 'chat',
      agentId,
      sessionId,
      content: buildCommitNudgeCliPrompt({ branch: 'agent-hub/dev/session-x' }),
      _skipUserMessagePersist: true,
    });

    // Title untouched — the nudge text must not become the session name.
    expect(sessionName(sessionId)).toBe(initialName);
  });

  it('does not rename the session on an auto-continuation turn', async () => {
    const initialName = 'Fix streaming reconnect';
    const { agentId, sessionId } = seedAutoTitledSession(`${prefix}-cont`, initialName);
    const handleChat = stubChatDeps(agentId);

    await handleChat(null, {
      type: 'chat',
      agentId,
      sessionId,
      content: 'You left uncommitted changes on the branch and there is no local commit.',
      _autoContinuation: true,
    });

    expect(sessionName(sessionId)).toBe(initialName);
  });

  it('positive control: a real user turn still renames an auto-owned title', async () => {
    const initialName = 'Old placeholder topic';
    const { agentId, sessionId } = seedAutoTitledSession(`${prefix}-real`, initialName);
    const handleChat = stubChatDeps(agentId);

    await handleChat(null, {
      type: 'chat',
      agentId,
      sessionId,
      content: 'Add a dark mode toggle to settings',
    });

    // The rename path IS reachable in this harness — proving the two tests
    // above are blocked by the guard, not by an unreachable code path.
    expect(sessionName(sessionId)).toBe('Add a dark mode toggle to settings');
  });
});
