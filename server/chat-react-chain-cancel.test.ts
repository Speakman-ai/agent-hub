/**
 * Regression for "Stop cancels the ReAct / auto-continuation chain" at the
 * chat-handler entry gate (chat.ts, the `isAutoContinuation` cancel block).
 *
 * The unit tests in react-chain-cancel.test.ts / session-chat-cancel.test.ts
 * only prove the flag helper works and that cancel sets it. These tests pin the
 * behavior that actually matters: a queued `_autoContinuation` turn is DROPPED
 * (never proceeds to agent lookup / spawn) once a cancel is requested, an
 * uncancelled continuation still proceeds, and a genuine user turn clears a
 * stale flag. A refactor that removes the entry gate makes these fail.
 *
 * findAgent is stubbed to return null so the handler short-circuits right after
 * the gate — no CLI is ever spawned. `findAgent` call vs. no-call is the probe
 * for whether the continuation passed the gate.
 */
import './test/setup.js';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'crypto';
import createChatHandler, { type ChatHandlerDeps } from './chat.js';
import type { ChildProcess } from 'child_process';
import {
  clearReactChainCancel,
  isReactChainCancelRequested,
  requestReactChainCancel,
} from './react-chain-cancel.js';

vi.mock('./per-user-cli-spawn.js', () => ({
  EngineAuthRequiredError: class EngineAuthRequiredError extends Error {},
  resolveSessionCliSpawnEnv: vi.fn(() => ({})),
}));

function stubChatDeps(): {
  handler: ReturnType<typeof createChatHandler>;
  findAgent: ReturnType<typeof vi.fn>;
  drainQueue: ReturnType<typeof vi.fn>;
} {
  const findAgent = vi.fn(() => null);
  const drainQueue = vi.fn();

  const deps: ChatHandlerDeps = {
    broadcast: vi.fn(),
    createCursorChat: undefined,
    findAgent: findAgent as unknown as ChatHandlerDeps['findAgent'],
    getEnrichedAgent: () => null,
    activeProcesses: new Map<string, ChildProcess>(),
    autonomousProjects: new Set(),
    getClaudeBin: () => '/bin/true',
    getCursorBin: () => '/bin/true',
    getGeminiBin: () => '/bin/true',
    getCodexBin: () => '/bin/true',
    getGrokBin: () => '/bin/true',
    uploadsDir: '/tmp',
    resolveSlashSkill: vi.fn(),
    ensureWorktree: vi.fn(async () => '/tmp'),
    drainQueue,
    autoCommitAndPR: vi.fn(async () => undefined),
    tryAutonomousDispatch: vi.fn(),
  };

  return { handler: createChatHandler(deps), findAgent, drainQueue };
}

describe('handleChat — ReAct chain-cancel entry gate', () => {
  const agentId = `chain-cancel-${randomUUID().slice(0, 8)}`;
  let sessionId: string;

  beforeEach(() => {
    sessionId = `sess-${randomUUID().slice(0, 8)}`;
  });

  afterEach(() => {
    clearReactChainCancel(sessionId);
  });

  it('drops a queued auto-continuation when a cancel is requested', async () => {
    const { handler, findAgent, drainQueue } = stubChatDeps();
    requestReactChainCancel(sessionId);

    await handler.handleChat(null, {
      type: 'chat',
      agentId,
      sessionId,
      content: 'auto-continue prompt',
      _autoContinuation: true,
      _continuationDepth: 1,
    });

    // Dropped at the gate — never reached agent lookup / spawn.
    expect(findAgent).not.toHaveBeenCalled();
    expect(drainQueue).toHaveBeenCalledWith(sessionId);
    // Flag consumed so a later genuine turn is not wrongly suppressed.
    expect(isReactChainCancelRequested(sessionId)).toBe(false);
  });

  it('lets an auto-continuation proceed when no cancel is pending', async () => {
    const { handler, findAgent, drainQueue } = stubChatDeps();
    // No requestReactChainCancel — gate must not fire.

    await handler.handleChat(null, {
      type: 'chat',
      agentId,
      sessionId,
      content: 'auto-continue prompt',
      _autoContinuation: true,
      _continuationDepth: 1,
    });

    // Passed the gate into the normal flow (findAgent returns null → early out).
    expect(findAgent).toHaveBeenCalledWith(agentId);
    // Not dropped via the cancel path.
    expect(drainQueue).not.toHaveBeenCalled();
  });

  it('clears a stale cancel flag on a genuine (non-continuation) user turn', async () => {
    const { handler, findAgent } = stubChatDeps();
    requestReactChainCancel(sessionId);

    await handler.handleChat(null, {
      type: 'chat',
      agentId,
      sessionId,
      content: 'a brand new user message',
    });

    // Fresh user intent supersedes the pending Stop.
    expect(isReactChainCancelRequested(sessionId)).toBe(false);
    // And it proceeds into the normal flow rather than being dropped.
    expect(findAgent).toHaveBeenCalledWith(agentId);
  });
});
