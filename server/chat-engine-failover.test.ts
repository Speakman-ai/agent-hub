/**
 * In-session engine failover.
 *
 * A turn can start on a healthy engine and die mid-flight when the provider's
 * quota window closes. Same-engine retry cannot fix that (the window resets in
 * hours), so before this behaviour existed the session simply stopped and
 * waited for a human to switch the engine picker by hand — which is exactly
 * what nobody is around to do for an autonomous or background session.
 *
 * These tests drive real handleChat turns against stub CLI scripts (never the
 * real claude/cursor/codex/grok binaries — see server/test/setup.ts) and
 * assert the observable contract: the session row moves to the next
 * authenticated engine, and the transcript says so.
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
import type { Agent, EnrichedAgent, MessageRow, Project, SessionRow } from './types.js';
import type { EngineAvailability, SupportedEngine } from './engine-availability.js';

vi.mock('./per-user-cli-spawn.js', () => ({
  EngineAuthRequiredError: class EngineAuthRequiredError extends Error {},
  resolveSessionCliSpawnEnv: vi.fn(() => ({})),
  userHasEngineCreds: vi.fn(() => false),
  resolveUserCliCredOverride: vi.fn(() => undefined),
}));

/** Engines the probe should report as available; mutated per test. */
let availableEngines: SupportedEngine[] = [];

vi.mock('./engine-availability.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./engine-availability.js')>();
  return {
    ...actual,
    probeAllEngineAvailability: vi.fn(async () => {
      const out = {} as Record<SupportedEngine, EngineAvailability>;
      for (const engine of actual.ALL_SUPPORTED_ENGINES) {
        out[engine] = availableEngines.includes(engine)
          ? { engine, available: true }
          : { engine, available: false, reason: 'no-credentials', detail: 'no creds on account' };
      }
      return out;
    }),
  };
});

const testPrefix = `ef-${randomUUID().slice(0, 8)}`;
let binDir: string;
let usageLimitBin: string;
let contextOverflowBin: string;

beforeAll(() => {
  binDir = mkdtempSync(path.join(tmpdir(), 'engine-failover-'));
  usageLimitBin = path.join(binDir, 'usage-limit.sh');
  writeFileSync(
    usageLimitBin,
    '#!/bin/sh\ncat > /dev/null 2>&1\necho "Claude AI usage limit reached|1751500000" >&2\nexit 1\n',
  );
  chmodSync(usageLimitBin, 0o755);

  contextOverflowBin = path.join(binDir, 'context-overflow.sh');
  writeFileSync(
    contextOverflowBin,
    '#!/bin/sh\ncat > /dev/null 2>&1\necho "prompt is too long: 250000 tokens > 200000 maximum" >&2\nexit 1\n',
  );
  chmodSync(contextOverflowBin, 0o755);
});

afterAll(() => {
  rmSync(binDir, { recursive: true, force: true });
});

function makeDeps(agentId: string, bin: string): ChatHandlerDeps {
  const agent = { id: agentId, name: 'Failover agent', engine: 'claude-code' } as Agent;
  const project = {
    id: 'proj-engine-failover',
    name: 'Engine failover project',
    cwd: '/tmp',
    ahw: '',
    agents: [],
  } as unknown as Project;
  const enriched = {
    id: agentId,
    name: 'Failover agent',
    engine: 'claude-code',
    projectId: 'proj-engine-failover',
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
    'engine failover test',
    'claude-code',
    'claude-opus-4-8',
    0,
    0,
    1,
  );
  // A stale resume id from the failing engine must not survive the switch.
  getStmts().updateSessionEngineSessionId.run('claude-resume-id', sessionId);
  return { agentId, sessionId };
}

function session(sessionId: string): SessionRow {
  return getStmts().getSession.get(sessionId) as SessionRow;
}

function systemMessages(sessionId: string): MessageRow[] {
  return (getStmts().getMessages.all(sessionId) as MessageRow[]).filter((m) => m.role === 'system');
}

function userMessages(sessionId: string): MessageRow[] {
  return (getStmts().getMessages.all(sessionId) as MessageRow[]).filter((m) => m.role === 'user');
}

function failoverNotice(sessionId: string): MessageRow | undefined {
  return systemMessages(sessionId).find(
    (m) => !!m.metadata && JSON.parse(m.metadata).kind === 'engine_failover',
  );
}

async function waitFor(cond: () => boolean, timeoutMs = 8_000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe('in-session engine failover', () => {
  it('moves the session to the next chain engine when usage runs out', async () => {
    availableEngines = ['codex-cli'];
    const { agentId, sessionId } = seedSession('usage');
    const { handleChat } = createChatHandler(makeDeps(agentId, usageLimitBin));

    await handleChat(null, { type: 'chat', agentId, sessionId, content: 'do work' });

    await waitFor(() => session(sessionId).engine === 'codex-cli');
    const row = session(sessionId);
    expect(row.engine).toBe('codex-cli');
    expect(row.model).toBeTruthy();
    expect(row.model).not.toBe('claude-opus-4-8');
    // A Claude resume id means nothing to Codex — carrying it over would make
    // the new CLI try to resume a conversation it never had.
    expect(row.engine_session_id).toBeNull();
  });

  it('re-drives the original request without duplicating the user message', async () => {
    // The replacement turn re-sends the user's original content, because this
    // failure path produced no output — there is nothing to "resume", and a
    // recovery-prompt continuation would strand the actual request. handleChat
    // persists a user message for every non-continuation turn, so the
    // re-dispatch must suppress that write or the transcript shows the user
    // asking twice.
    availableEngines = ['codex-cli'];
    const { agentId, sessionId } = seedSession('no-dupe');
    const { handleChat } = createChatHandler(makeDeps(agentId, usageLimitBin));

    await handleChat(null, { type: 'chat', agentId, sessionId, content: 'ship the thing' });

    await waitFor(() => session(sessionId).engine === 'codex-cli');
    // Let the replacement turn spawn and close before counting.
    await waitFor(() => systemMessages(sessionId).length > 0);
    const users = userMessages(sessionId);
    expect(users).toHaveLength(1);
    expect(users[0].content).toBe('ship the thing');
  });

  it('warns in the transcript, naming the error and the engine that took over', async () => {
    availableEngines = ['grok-cli'];
    const { agentId, sessionId } = seedSession('notice');
    const { handleChat } = createChatHandler(makeDeps(agentId, usageLimitBin));

    await handleChat(null, { type: 'chat', agentId, sessionId, content: 'do work' });

    await waitFor(() => !!failoverNotice(sessionId));
    const notice = failoverNotice(sessionId)!;
    expect(notice.content).toContain('usage quota');
    expect(notice.content).toContain('Claude AI usage limit reached');
    expect(notice.content).toContain('Grok');
    const meta = JSON.parse(notice.metadata!);
    expect(meta).toMatchObject({ kind: 'engine_failover', from: 'claude-code', to: 'grok-cli' });
  });

  it('does not switch engines for a failure another engine cannot fix', async () => {
    // Context overflow reproduces identically everywhere; switching would
    // burn a second provider's quota to reach the same dead end.
    availableEngines = ['codex-cli', 'grok-cli', 'cursor-agent'];
    const { agentId, sessionId } = seedSession('permanent');
    const { handleChat } = createChatHandler(makeDeps(agentId, contextOverflowBin));

    await handleChat(null, { type: 'chat', agentId, sessionId, content: 'do work' });

    await waitFor(() => session(sessionId).last_turn_error !== null);
    expect(session(sessionId).engine).toBe('claude-code');
    expect(failoverNotice(sessionId)).toBeUndefined();
  });

  it('explains the dead end when no other engine is authenticated', async () => {
    availableEngines = [];
    const { agentId, sessionId } = seedSession('none');
    const { handleChat } = createChatHandler(makeDeps(agentId, usageLimitBin));

    await handleChat(null, { type: 'chat', agentId, sessionId, content: 'do work' });

    await waitFor(() =>
      systemMessages(sessionId).some(
        (m) => !!m.metadata && JSON.parse(m.metadata).kind === 'engine_failover_unavailable',
      ),
    );
    expect(session(sessionId).engine).toBe('claude-code');
    const notice = systemMessages(sessionId).find(
      (m) => !!m.metadata && JSON.parse(m.metadata).kind === 'engine_failover_unavailable',
    )!;
    expect(notice.content).toContain('no fallback engine is available');
  });
});
