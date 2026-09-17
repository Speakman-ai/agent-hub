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
import type { ActiveChatProcess } from './active-chat-process.js';
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
let codexUsageLimitBin: string;
let grokSuccessBin: string;

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

  // Codex surfaces usage exhaustion as a `turn.failed` JSONL event on stdout
  // (not a stderr line like Claude), so the codex-format path must be exercised
  // with a codex-shaped stub. See server/stream-parser.ts normalizeCodex.
  codexUsageLimitBin = path.join(binDir, 'codex-usage-limit.sh');
  const codexEvent = JSON.stringify({
    type: 'turn.failed',
    error: { message: 'You have hit your usage limit. Try again later.' },
  });
  writeFileSync(
    codexUsageLimitBin,
    `#!/bin/sh\ncat > /dev/null 2>&1\ncat <<'JSON'\n${codexEvent}\nJSON\nexit 1\n`,
  );
  chmodSync(codexUsageLimitBin, 0o755);

  // Healthy Grok stub: emits a codex-shaped agent_message + clean turn.completed
  // and exits 0. (grok-cli and codex-cli share the JSONL event shape.)
  grokSuccessBin = path.join(binDir, 'grok-success.sh');
  const okMsg = JSON.stringify({
    type: 'item.completed',
    item: { id: 'm1', type: 'agent_message', text: 'done on grok' },
  });
  const okDone = JSON.stringify({
    type: 'turn.completed',
    usage: { input_tokens: 1, output_tokens: 1 },
  });
  writeFileSync(
    grokSuccessBin,
    `#!/bin/sh\ncat > /dev/null 2>&1\ncat <<'JSON'\n${okMsg}\n${okDone}\nJSON\nexit 0\n`,
  );
  chmodSync(grokSuccessBin, 0o755);
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

/**
 * Cross-turn failover memory. Regression for the support report "if you max out
 * Codex it does not switch to grok": a session already sitting on Codex (moved
 * there by an earlier Claude→Codex failover) that maxes out Codex must fail
 * over DIRECTLY to grok, not bounce back onto claude-code — which the earlier
 * failover already proved is exhausted. Without the persisted skip-list the
 * Codex chain (codex → claude → grok → cursor) re-selects the dead claude first.
 */
describe('cross-turn engine-exhaustion memory', () => {
  function makeDepsPerEngine(
    agentId: string,
    bins: { claude: string; codex: string; grok: string; cursor: string },
  ): ChatHandlerDeps {
    const base = makeDeps(agentId, bins.codex);
    return {
      ...base,
      getClaudeBin: () => bins.claude,
      getCodexBin: () => bins.codex,
      getGrokBin: () => bins.grok,
      getCursorBin: () => bins.cursor,
      getGeminiBin: () => bins.claude,
    };
  }

  function seedCodexSession(
    suffix: string,
    exhausted: string | null,
  ): { agentId: string; sessionId: string } {
    const agentId = `${testPrefix}-xt-agent-${suffix}`;
    const sessionId = `${testPrefix}-xt-sess-${suffix}`;
    getStmts().createSession.run(
      sessionId,
      agentId,
      'x-turn test',
      'codex-cli',
      'gpt-5-codex',
      0,
      0,
      1,
    );
    if (exhausted) getStmts().updateSessionFailoverExhausted.run(exhausted, sessionId);
    return { agentId, sessionId };
  }

  it('skips an already-exhausted engine and fails over directly to grok', async () => {
    // Claude + Codex are both authenticated (the availability probe cannot see
    // usage exhaustion), so a naive walk would pick claude-code first.
    availableEngines = ['claude-code', 'codex-cli', 'grok-cli', 'cursor-agent'];
    // A prior turn's Claude→Codex failover recorded claude-code as exhausted.
    const { agentId, sessionId } = seedCodexSession(
      'direct',
      JSON.stringify({ 'claude-code': Date.now() }),
    );
    const { handleChat } = createChatHandler(
      makeDepsPerEngine(agentId, {
        claude: usageLimitBin,
        codex: codexUsageLimitBin,
        grok: grokSuccessBin,
        cursor: usageLimitBin,
      }),
    );

    await handleChat(null, { type: 'chat', agentId, sessionId, content: 'do work' });

    await waitFor(() => session(sessionId).engine === 'grok-cli');
    const row = session(sessionId);
    expect(row.engine).toBe('grok-cli');

    // Exactly one failover hop, straight from codex to grok — claude-code was
    // skipped, not visited.
    const hops = systemMessages(sessionId)
      .filter((m) => !!m.metadata && JSON.parse(m.metadata).kind === 'engine_failover')
      .map((m) => {
        const md = JSON.parse(m.metadata!);
        return `${md.from}->${md.to}`;
      });
    expect(hops).toEqual(['codex-cli->grok-cli']);

    // The clean turn on grok cleared grok from the skip-list; the codex hop
    // recorded codex-cli; claude-code stays marked.
    const map = JSON.parse(row.failover_exhausted_engines ?? '{}');
    expect(Object.keys(map).sort()).toEqual(['claude-code', 'codex-cli']);
  });

  it('records the engine a usage failover moved off for the next turn', async () => {
    availableEngines = ['codex-cli', 'grok-cli'];
    const { agentId, sessionId } = seedCodexSession('record', null);
    const { handleChat } = createChatHandler(
      makeDepsPerEngine(agentId, {
        claude: usageLimitBin,
        codex: codexUsageLimitBin,
        grok: grokSuccessBin,
        cursor: usageLimitBin,
      }),
    );

    await handleChat(null, { type: 'chat', agentId, sessionId, content: 'do work' });

    await waitFor(() => session(sessionId).engine === 'grok-cli');
    const map = JSON.parse(session(sessionId).failover_exhausted_engines ?? '{}');
    // codex-cli is recorded (usage-exhausted); grok-cli is NOT (clean turn cleared it).
    expect(Object.keys(map)).toEqual(['codex-cli']);
  });
});
