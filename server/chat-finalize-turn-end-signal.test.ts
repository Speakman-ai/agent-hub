/**
 * Finalize turn-end signalling on terminal close paths.
 *
 * Regression for "Grok fails at the finalize — grok seems to get stuck when
 * trying to finalize and auto merge" (support ticket 1fb24239).
 *
 * A Finalize fix-dispatch / rebase-conflict wait subscribes to the per-session
 * turn-end bus (server/finalize/turn-end.ts) and blocks until it fires. The
 * chat close-handler only fired `notifyFinalizeSessionTurnEnd` on the clean
 * success path; two terminal early-returns — an errored close with no output
 * (the common failure mode for non-resuming engines like grok-cli, which
 * re-send the whole prompt every turn) and a terminated turn — returned
 * WITHOUT signalling anything. Under the automation-driven `agent_block`
 * trigger the stall watchdog is disabled, so the wait hung until the ~60-min
 * active-time budget: exactly what "gets stuck at finalize" looks like.
 *
 * These tests drive real handleChat turns against a stub CLI that exits
 * non-zero with no output (never the real claude/cursor/gemini/codex/grok
 * binaries — see server/test/setup.ts) and assert the finalize turn-end bus
 * receives a `spawn_failed` outcome so the orchestrator settles the run
 * instead of hanging.
 */
import './test/setup.js';
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { randomUUID } from 'crypto';
import { mkdtempSync, writeFileSync, rmSync, chmodSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { getStmts } from './db.js';
import createChatHandler, { type ChatHandlerDeps } from './chat.js';
import {
  finalizeTurnEndSubscriber,
  __testResetFinalizeTurnEndListeners,
} from './finalize/turn-end.js';
import type { ActiveChatProcess } from './active-chat-process.js';
import type { Agent, EnrichedAgent, Project } from './types.js';

vi.mock('./per-user-cli-spawn.js', () => ({
  EngineAuthRequiredError: class EngineAuthRequiredError extends Error {},
  resolveSessionCliSpawnEnv: vi.fn(() => ({})),
}));

const testPrefix = `fte-${randomUUID().slice(0, 8)}`;
let binDir: string;
let failBin: string;

beforeAll(() => {
  binDir = mkdtempSync(path.join(tmpdir(), 'finalize-turn-end-'));
  // A turn that ends in an error with no assembled output — the branch that
  // used to return without signalling the finalize turn-end bus.
  failBin = path.join(binDir, 'fail.sh');
  writeFileSync(failBin, '#!/bin/sh\ncat > /dev/null 2>&1\nexit 1\n');
  chmodSync(failBin, 0o755);
});

afterAll(() => {
  rmSync(binDir, { recursive: true, force: true });
});

beforeEach(() => {
  __testResetFinalizeTurnEndListeners();
});

function makeDeps(agentId: string, bin: string): ChatHandlerDeps {
  const agent = { id: agentId, name: 'Finalize turn-end agent', engine: 'grok-cli' } as Agent;
  const project = {
    id: 'proj-finalize-turn-end',
    name: 'Finalize turn-end project',
    cwd: '/tmp',
    ahw: '',
    agents: [],
  } as unknown as Project;
  const enriched = {
    id: agentId,
    name: 'Finalize turn-end agent',
    engine: 'grok-cli',
    projectId: 'proj-finalize-turn-end',
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
    'finalize turn-end test',
    'grok-cli',
    'grok-4',
    0,
    0,
    1,
  );
  return { agentId, sessionId };
}

async function waitFor(cond: () => boolean, timeoutMs = 5_000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe('Finalize turn-end signal on terminal close', () => {
  it('an errored close (no output) fires the finalize turn-end bus as spawn_failed', async () => {
    const { agentId, sessionId } = seedSession('errored');
    const outcomes: Array<'turn_ended' | 'spawn_failed'> = [];
    const unsubscribe = finalizeTurnEndSubscriber.subscribe(sessionId, (o) => outcomes.push(o));

    try {
      const { handleChat } = createChatHandler(makeDeps(agentId, failBin));
      await handleChat(null, { type: 'chat', agentId, sessionId, content: 'do the fix' });

      // Before the fix this never fired and the finalize wait hung until the
      // active-time budget. It must now settle the wait promptly.
      await waitFor(() => outcomes.length > 0);
      expect(outcomes).toContain('spawn_failed');
      expect(outcomes).not.toContain('turn_ended');
    } finally {
      unsubscribe();
    }
  });

  it('is a no-op when no finalize wait is subscribed for the session', async () => {
    const { agentId, sessionId } = seedSession('nowait');
    // No subscriber registered — the errored close must not throw. Drive the
    // turn and confirm handleChat resolves cleanly (a throwing notify would
    // surface as an unhandled rejection / thrown error here).
    const { handleChat } = createChatHandler(makeDeps(agentId, failBin));
    await expect(
      handleChat(null, { type: 'chat', agentId, sessionId, content: 'do the fix' }),
    ).resolves.toBeUndefined();
  });
});
