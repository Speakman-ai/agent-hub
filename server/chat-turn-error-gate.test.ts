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
import { mkdtempSync, writeFileSync, rmSync, chmodSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { getStmts } from './db.js';
import createChatHandler, { type ChatHandlerDeps } from './chat.js';
import type { ChildProcess } from 'child_process';
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
    activeProcesses: new Map<string, ChildProcess>(),
    activeDelegationSessions: new Set(),
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
    handleDelegation: vi.fn(async () => []),
    handleDelegationCancel: vi.fn(),
    synthesizeResults: vi.fn(),
    parseDelegateBlock: vi.fn(),
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
