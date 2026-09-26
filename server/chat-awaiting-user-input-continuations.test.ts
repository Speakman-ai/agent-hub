/**
 * Every host-scheduled continuation must stand down when the turn asked the
 * user for input. Each case makes one path eligible (ReAct hop, transient
 * error retry, engine failover, Finalize auto-start) and runs it twice: once
 * with a pending question, where the path must not fire, and once without,
 * as a control proving the setup really triggers it.
 *
 * Drives real handleChat turns against a fake CLI script; no real engine is
 * spawned (see server/test/setup.ts).
 */
import './test/setup.js';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'crypto';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import type { ActiveChatProcess } from './active-chat-process.js';
import { getStmts } from './db.js';
import createChatHandler, { type ChatHandlerDeps } from './chat.js';
import type { Agent, EnrichedAgent, MessageRow, Project, SessionRow } from './types.js';
import type { EngineAvailability, SupportedEngine } from './engine-availability.js';

vi.mock('./per-user-cli-spawn.js', () => ({
  EngineAuthRequiredError: class EngineAuthRequiredError extends Error {},
  resolveSessionCliSpawnEnv: vi.fn(() => ({})),
  userHasEngineCreds: vi.fn(() => false),
  resolveUserCliCredOverride: vi.fn(() => undefined),
}));

// Codex is the only other authenticated engine, so failover has somewhere to go.
vi.mock('./engine-availability.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./engine-availability.js')>();
  return {
    ...actual,
    probeAllEngineAvailability: vi.fn(async () => {
      const out = {} as Record<SupportedEngine, EngineAvailability>;
      for (const engine of actual.ALL_SUPPORTED_ENGINES) {
        out[engine] =
          engine === 'codex-cli'
            ? { engine, available: true }
            : { engine, available: false, reason: 'no-credentials', detail: 'none' };
      }
      return out;
    }),
  };
});

const testPrefix = `await-cont-${randomUUID().slice(0, 8)}`;
const agentId = `${testPrefix}-agent`;
let tmpRoot: string;

beforeAll(() => {
  tmpRoot = mkdtempSync(path.join(tmpdir(), 'await-cont-'));
});

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

type AutoCommit = ChatHandlerDeps['autoCommitAndPR'];

function makeDeps(
  activeProcesses: Map<string, ActiveChatProcess>,
  bin: string,
  autoCommitAndPR: AutoCommit,
): ChatHandlerDeps {
  const agent = { id: agentId, name: 'Await target', engine: 'claude-code' } as Agent;
  const project = {
    id: `${testPrefix}-project`,
    name: 'Await target project',
    cwd: tmpRoot,
    ahw: tmpRoot,
    mode: 'dev',
    agents: [],
  } as Project;
  const enriched = {
    id: agentId,
    name: 'Await target',
    engine: 'claude-code',
    projectId: project.id,
    cwd: tmpRoot,
    ahw: tmpRoot,
    workspace: tmpRoot,
  } as EnrichedAgent;
  return {
    broadcast: () => {},
    createCursorChat: undefined,
    findAgent: (id) => (id === agentId ? { project, agent } : null),
    getEnrichedAgent: (id) => (id === agentId ? enriched : null),
    activeProcesses,
    autonomousProjects: new Set(),
    getClaudeBin: () => bin,
    getCursorBin: () => bin,
    getGeminiBin: () => bin,
    getCodexBin: () => bin,
    getGrokBin: () => bin,
    uploadsDir: tmpRoot,
    resolveSlashSkill: vi.fn(),
    ensureWorktree: vi.fn(async () => tmpRoot),
    drainQueue: vi.fn(),
    autoCommitAndPR,
    tryAutonomousDispatch: vi.fn(),
  };
}

function seedSession(): string {
  const sessionId = `${testPrefix}-session-${randomUUID().slice(0, 8)}`;
  getStmts().createSession.run(sessionId, agentId, 'Await', 'claude-code', 'auto', 1, 0, 1);
  return sessionId;
}

async function waitFor(cond: () => boolean, timeoutMs = 10_000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/**
 * Fake claude-code CLI. Records each spawn's prompt, replays the stream lines
 * on the first spawn only (from a file, since fenced blocks contain
 * backticks), and exits with `firstExit` on that spawn and 0 afterwards.
 */
function makeFakeCli(streamJsonLines: string[], firstExit = 0): { bin: string; argFile: string } {
  const id = randomUUID();
  const argFile = path.join(tmpRoot, `${id}.args`);
  const streamFile = path.join(tmpRoot, `${id}.jsonl`);
  const onceFile = path.join(tmpRoot, `${id}.once`);
  const bin = path.join(tmpRoot, `${id}-fake-cli.sh`);
  writeFileSync(streamFile, streamJsonLines.map((line) => `${line}\n`).join(''));
  writeFileSync(
    bin,
    `#!/bin/sh\n` +
      `for a in "$@"; do last="$a"; done\n` +
      `printf '%s\\000' "$last" >> "${argFile}"\n` +
      `cat >/dev/null 2>&1\n` +
      `if [ ! -f "${onceFile}" ]; then\n` +
      `  : > "${onceFile}"\n` +
      `  cat "${streamFile}"\n` +
      `  exit ${firstExit}\n` +
      `fi\n` +
      `exit 0\n`,
  );
  chmodSync(bin, 0o755);
  return { bin, argFile };
}

function spawnCount(argFile: string): number {
  if (!existsSync(argFile)) return 0;
  return readFileSync(argFile, 'utf8').split('\u0000').length - 1;
}

interface TurnResult {
  sessionId: string;
  spawns: number;
  autoCommit: ReturnType<typeof vi.fn>;
}

/** Runs one user turn, then waits `settleMs` for anything the Hub schedules after it. */
async function runTurn(
  streamJsonLines: string[],
  opts: { firstExit?: number; settleMs?: number } = {},
): Promise<TurnResult> {
  const sessionId = seedSession();
  const { bin, argFile } = makeFakeCli(streamJsonLines, opts.firstExit ?? 0);
  const activeProcesses = new Map<string, ActiveChatProcess>();
  const autoCommit = vi.fn(async () => undefined);
  const { handleChat } = createChatHandler(
    makeDeps(activeProcesses, bin, autoCommit as unknown as AutoCommit),
  );
  await handleChat(null, { type: 'chat', agentId, sessionId, content: 'Do the thing.' });
  await waitFor(() => spawnCount(argFile) >= 1);
  await waitFor(() => autoCommit.mock.calls.length >= 1);
  await new Promise((resolve) => setTimeout(resolve, opts.settleMs ?? 400));
  await waitFor(() => activeProcesses.size === 0);
  return { sessionId, spawns: spawnCount(argFile), autoCommit };
}

function textLine(text: string): string {
  return JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text }] } });
}

function errorResultLine(text: string): string {
  return JSON.stringify({ type: 'result', subtype: 'error', is_error: true, result: text });
}

function systemKinds(sessionId: string): string[] {
  return (getStmts().getMessages.all(sessionId) as MessageRow[])
    .filter((m) => m.role === 'system' && m.metadata)
    .map((m) => String(JSON.parse(m.metadata as string).kind));
}

const ASK = [
  '```agenthub:ask',
  JSON.stringify({
    askId: 'env',
    question: 'Which environment?',
    header: 'Env',
    options: [
      { label: 'dev', description: 'Dev' },
      { label: 'prod', description: 'Prod' },
    ],
  }),
  '```',
].join('\n');

const CREDENTIAL = [
  '```agenthub:credential-request',
  JSON.stringify({
    requestId: 'login',
    service: 'Tracker',
    purpose: 'Sign in',
    fields: [{ key: 'password', label: 'Password', type: 'password' }],
  }),
  '```',
].join('\n');

// An unknown skill still injects a load-error block, which is enough context
// to make the ReAct chain eligible for another hop without any network.
const REACT = `<agenthub:react>${JSON.stringify({
  actions: [{ tool: 'skill', name: 'no-such-skill-for-await-test' }],
})}</agenthub:react>`;

describe('ReAct hop', () => {
  it('control: loaded context schedules a follow-up turn', async () => {
    const { spawns } = await runTurn([textLine(`Loading a skill.\n\n${REACT}`)]);
    expect(spawns).toBe(2);
  });

  it('is suppressed by a pending ask picker', async () => {
    const { spawns } = await runTurn([textLine(`Which one?\n\n${ASK}\n\n${REACT}`)]);
    expect(spawns).toBe(1);
  });

  it('is suppressed by a pending credential request', async () => {
    const { spawns } = await runTurn([textLine(`Need a login.\n\n${CREDENTIAL}\n\n${REACT}`)]);
    expect(spawns).toBe(1);
  });
});

describe('transient error retry', () => {
  const transient = errorResultLine('API Error: socket hang up');

  it('control: an errored turn with output schedules a retry', async () => {
    const { sessionId } = await runTurn([textLine('Working on it.'), transient], {
      firstExit: 1,
    });
    expect(systemKinds(sessionId)).toContain('turn_error_retry');
  });

  it('is suppressed by a pending ask picker', async () => {
    const { sessionId, spawns } = await runTurn([textLine(`Which one?\n\n${ASK}`), transient], {
      firstExit: 1,
      settleMs: 2_500,
    });
    expect(systemKinds(sessionId)).not.toContain('turn_error_retry');
    expect(spawns).toBe(1);
  });
});

describe('engine failover', () => {
  const usage = errorResultLine('Claude AI usage limit reached|1751500000');

  it('control: an exhausted engine fails over and continues', async () => {
    const { sessionId, spawns } = await runTurn([textLine('Working on it.'), usage], {
      firstExit: 1,
    });
    expect(systemKinds(sessionId)).toContain('engine_failover');
    expect((getStmts().getSession.get(sessionId) as SessionRow).engine).toBe('codex-cli');
    expect(spawns).toBe(2);
  });

  it('is suppressed by a pending credential request', async () => {
    const { sessionId, spawns } = await runTurn(
      [textLine(`Need a login.\n\n${CREDENTIAL}`), usage],
      { firstExit: 1 },
    );
    expect(systemKinds(sessionId)).not.toContain('engine_failover');
    expect((getStmts().getSession.get(sessionId) as SessionRow).engine).toBe('claude-code');
    expect(spawns).toBe(1);
  });
});

describe('Finalize auto-start', () => {
  function allowFinalize(autoCommit: ReturnType<typeof vi.fn>): unknown {
    const call = autoCommit.mock.calls.at(-1) as unknown[];
    return (call[call.length - 1] as { allowFinalizeAutoStart?: boolean }).allowFinalizeAutoStart;
  }

  it('control: a clean turn allows Finalize to auto-start', async () => {
    const { autoCommit } = await runTurn([textLine('All done.')]);
    expect(allowFinalize(autoCommit)).toBe(true);
  });

  it('is blocked by a pending ask picker', async () => {
    const { autoCommit } = await runTurn([textLine(`Ship to which env?\n\n${ASK}`)]);
    expect(allowFinalize(autoCommit)).toBe(false);
  });

  it('is blocked by a pending credential request', async () => {
    const { autoCommit } = await runTurn([textLine(`Need a login.\n\n${CREDENTIAL}`)]);
    expect(allowFinalize(autoCommit)).toBe(false);
  });
});
