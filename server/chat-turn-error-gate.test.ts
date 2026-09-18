/**
 * Turn-error gate lifecycle — `sessions.last_turn_error` must clear ONLY on
 * a verifiably clean turn close, never at spawn.
 *
 * Regression for the review finding on the turn-error gate PR: the first
 * implementation cleared the flag when the CLI process spawned. In the
 * transient retry paths the recovery spawn immediately nulled the flag, so a
 * parked ready_to_push Finalize run (or an auto-start check) could fire
 * while the recovery turn was still in flight — violating the fail-closed
 * contract. These tests drive real handleChat turns against stub CLI
 * scripts (never the real claude/cursor/gemini/codex binaries — see
 * server/test/setup.ts) and assert the gate's observable lifecycle.
 */
import './test/setup.js';
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'crypto';
import { once } from 'node:events';
import {
  buildRunCancelledSystemMessage,
  consumeSessionTermination,
  markSessionTermination,
} from './process-termination.js';
import { mkdtempSync, writeFileSync, rmSync, chmodSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { getStmts } from './db.js';
import { beginSessionRecovery, endSessionRecovery } from './session-recovery.js';
import createChatHandler, { type ChatHandlerDeps } from './chat.js';
import type { ChildProcess } from 'child_process';
import type { ActiveChatProcess } from './active-chat-process.js';
import type { Agent, EnrichedAgent, Project, SessionRow } from './types.js';

vi.mock('./per-user-cli-spawn.js', () => ({
  EngineAuthRequiredError: class EngineAuthRequiredError extends Error {},
  resolveSessionCliSpawnEnv: vi.fn(() => ({})),
}));

const testPrefix = `teg-${randomUUID().slice(0, 8)}`;
let binDir: string;
let slowCleanBin: string;
let failBin: string;

beforeAll(() => {
  binDir = mkdtempSync(path.join(tmpdir(), 'turn-error-gate-'));
  // Clean turn that stays in flight long enough for the mid-flight assert.
  slowCleanBin = path.join(binDir, 'slow-clean.sh');
  writeFileSync(slowCleanBin, '#!/bin/sh\ncat > /dev/null 2>&1\nsleep 0.5\nexit 0\n');
  chmodSync(slowCleanBin, 0o755);
  // Turn that ends in an error with no output.
  failBin = path.join(binDir, 'fail.sh');
  writeFileSync(failBin, '#!/bin/sh\ncat > /dev/null 2>&1\nexit 1\n');
  chmodSync(failBin, 0o755);
});

afterAll(() => {
  rmSync(binDir, { recursive: true, force: true });
});

function makeDeps(agentId: string, bin: string): ChatHandlerDeps {
  const agent = {
    id: agentId,
    name: 'Turn-error gate agent',
    engine: 'claude-code',
  } as Agent;
  const project = {
    id: 'proj-turn-error-gate',
    name: 'Turn-error gate project',
    cwd: '/tmp',
    ahw: '',
    agents: [],
  } as unknown as Project;
  const enriched = {
    id: agentId,
    name: 'Turn-error gate agent',
    engine: 'claude-code',
    projectId: 'proj-turn-error-gate',
    cwd: '/tmp',
    ahw: '',
    workspace: '/tmp',
  } as unknown as EnrichedAgent;
  return {
    broadcast: () => {},
    createCursorChat: undefined,
    findAgent: (id) => (id === agentId ? { project, agent } : null),
    getEnrichedAgent: (id) => (id === agentId ? enriched : null),
    activeProcesses: new Map<string, ActiveChatProcess>(),
    autonomousProjects: new Set(),
    getClaudeBin: () => bin,
    getCursorBin: () => bin,
    getGeminiBin: () => bin,
    getCodexBin: () => bin,
    getGrokBin: () => bin,
    uploadsDir: '/tmp',
    resolveSlashSkill: vi.fn(),
    ensureWorktree: vi.fn(async () => '/tmp'),
    drainQueue: vi.fn(),
    autoCommitAndPR: vi.fn(async () => undefined),
    tryAutonomousDispatch: vi.fn(),
  };
}

function seedSession(suffix: string): { agentId: string; sessionId: string } {
  const agentId = `${testPrefix}-agent-${suffix}`;
  const sessionId = `${testPrefix}-sess-${suffix}`;
  getStmts().createSession.run(
    sessionId,
    agentId,
    'turn-error gate test',
    'claude-code',
    'claude-opus-4-8',
    0,
    0,
    1,
  );
  return { agentId, sessionId };
}

function getFlag(sessionId: string): string | null {
  const row = getStmts().getSession.get(sessionId) as SessionRow | undefined;
  return row?.last_turn_error ?? null;
}

async function waitFor(cond: () => boolean, timeoutMs = 5_000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe('turn-error gate lifecycle (sessions.last_turn_error)', () => {
  it.each([
    { code: null, signal: 'SIGKILL' as const },
    { code: 0, signal: null },
  ])(
    'preserves the replacement cancellation when an old close arrives ($code, $signal)',
    async ({ code, signal }) => {
      const { agentId, sessionId } = seedSession(`late-close-${code ?? signal}`);
      const deps = makeDeps(agentId, slowCleanBin);
      const broadcast = vi.fn();
      deps.broadcast = broadcast;
      const { handleChat } = createChatHandler(deps);
      const stmts = getStmts();

      // Capture the actual chat close handler and reap the fixture process now,
      // so callback delivery order is controlled without timers or real CLIs.
      const startTurnWithDelayedClose = async () => {
        await handleChat(null, { type: 'chat', agentId, sessionId, content: 'do work' });
        const handle = deps.activeProcesses.get(sessionId)!;
        expect(handle?.hostChild).toBeDefined();
        const child = handle.hostChild as ChildProcess;
        const close = child.listeners('close').at(-1)!;
        expect(close).toBeTypeOf('function');
        child.removeListener('close', close);
        const closed = once(child, 'close');
        handle.kill('SIGKILL');
        await closed;
        return {
          handle,
          close: (code: number | null, signal: NodeJS.Signals | null) =>
            close.call(child, code, signal),
        };
      };

      try {
        const old = await startTurnWithDelayedClose();
        // Model the deregistration/replacement that makes the old callback stale.
        deps.activeProcesses.delete(sessionId);
        stmts.deleteActiveTask.run(sessionId);
        const replacement = await startTurnWithDelayedClose();
        const replacementTask = stmts.getActiveTask.get(sessionId);
        expect(replacementTask).toBeDefined();
        markSessionTermination(sessionId, 'user_cancel');
        broadcast.mockClear();
        vi.mocked(deps.drainQueue).mockClear();

        await old.close(code, signal);
        expect(deps.activeProcesses.get(sessionId)).toBe(replacement.handle);
        expect(stmts.getActiveTask.get(sessionId)).toEqual(replacementTask);
        expect(broadcast).not.toHaveBeenCalled();
        expect(deps.drainQueue).not.toHaveBeenCalled();

        // Its own close must still see the explicit Stop reason, not unknown_signal.
        await replacement.close(null, 'SIGTERM');
        expect(broadcast).toHaveBeenCalledWith(
          expect.objectContaining({
            type: 'message',
            sessionId,
            message: expect.objectContaining({
              role: 'system',
              content: buildRunCancelledSystemMessage('user_cancel'),
            }),
          }),
        );
        expect(broadcast).toHaveBeenCalledWith({ type: 'interrupted', sessionId });
        expect(deps.drainQueue).toHaveBeenCalledTimes(1);
        expect(deps.activeProcesses.has(sessionId)).toBe(false);
        expect(stmts.getActiveTask.get(sessionId)).toBeUndefined();
        expect(consumeSessionTermination(sessionId)).toBeNull();
      } finally {
        consumeSessionTermination(sessionId);
        deps.activeProcesses.delete(sessionId);
        stmts.deleteActiveTask.run(sessionId);
      }
    },
  );

  it('rejects new chat dispatch while recovery is stopping the old operation', async () => {
    const { agentId, sessionId } = seedSession('recovering');
    const deps = makeDeps(agentId, slowCleanBin);
    const accepted = vi.fn();
    const { handleChat } = createChatHandler(deps);
    beginSessionRecovery(sessionId);
    try {
      await handleChat(null, {
        type: 'chat',
        agentId,
        sessionId,
        content: 'new work',
        _onUserMessagePersisted: accepted,
      });
      expect(accepted).toHaveBeenCalledWith(false);
      expect(deps.activeProcesses.has(sessionId)).toBe(false);
      expect(getStmts().getNextQueuedMessage.get(sessionId)).toBeUndefined();
    } finally {
      endSessionRecovery(sessionId);
    }
  });

  it('sets the error gate before draining after an ENOENT spawn and preserves it on close', async () => {
    const { agentId, sessionId } = seedSession('enoent');
    const deps = makeDeps(agentId, path.join(binDir, 'missing-fixture'));
    const flagsAtDrain: Array<string | null> = [];
    deps.drainQueue = vi.fn(() => flagsAtDrain.push(getFlag(sessionId)));
    const { handleChat } = createChatHandler(deps);
    expect(getFlag(sessionId)).toBeNull();
    await handleChat(null, { type: 'chat', agentId, sessionId, content: 'do work' });
    await waitFor(() => flagsAtDrain.length > 0);
    expect(flagsAtDrain[0]).toBe('claude-code failed to spawn');
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(getFlag(sessionId)).toBe('claude-code failed to spawn');
    expect(deps.activeProcesses.has(sessionId)).toBe(false);
  });

  it('an errored close sets the flag (no-output, non-transient exit)', async () => {
    const { agentId, sessionId } = seedSession('err');
    const { handleChat } = createChatHandler(makeDeps(agentId, failBin));

    await handleChat(null, { type: 'chat', agentId, sessionId, content: 'do work' });

    await waitFor(() => getFlag(sessionId) !== null);
    expect(getFlag(sessionId)).toContain('exited with code 1');
  });

  // The reviewer-flagged race: a recovery turn spawning must NOT reopen the
  // automation gate. The flag stays set while the replacement turn is in
  // flight and clears only after its clean close.
  it('keeps the flag set while a recovery turn is in flight; clears only on clean close', async () => {
    const { agentId, sessionId } = seedSession('recover');
    const priorError = 'API Error: The socket connection was closed unexpectedly';
    getStmts().updateSessionLastTurnError.run(priorError, sessionId);

    const { handleChat } = createChatHandler(makeDeps(agentId, slowCleanBin));
    await handleChat(null, { type: 'chat', agentId, sessionId, content: 'continue the work' });

    // handleChat resolved => the CLI process spawned and is sleeping. A
    // parked ready_to_push auto-push checking the session NOW must still see
    // the errored state.
    expect(getFlag(sessionId)).toBe(priorError);

    // Clean close is the only event that reopens the gate.
    await waitFor(() => getFlag(sessionId) === null);
  });

  it('a turn that errors again keeps the gate closed after the recovery attempt', async () => {
    const { agentId, sessionId } = seedSession('still-bad');
    getStmts().updateSessionLastTurnError.run('API Error: 529 overloaded_error', sessionId);

    const { handleChat } = createChatHandler(makeDeps(agentId, failBin));
    await handleChat(null, { type: 'chat', agentId, sessionId, content: 'retry the work' });

    // Wait for the errored close to land its own flag value.
    await waitFor(
      () => getFlag(sessionId) !== null && getFlag(sessionId) !== 'API Error: 529 overloaded_error',
    );
    expect(getFlag(sessionId)).toContain('exited with code 1');
  });
});
