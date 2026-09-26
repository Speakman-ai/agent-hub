/**
 * When a turn asks the user for input (an `agenthub:ask` picker or an
 * `agenthub:credential-request` card), the Hub must stop driving the session:
 * no host-scheduled continuation, and a run that keeps calling tools after
 * asking is stopped so the question is the last thing on screen.
 *
 * Uses the argv-recording fake CLI pattern from
 * `chat-ephemeral-background-bash-wiring.test.ts` — no real `claude` is ever
 * spawned (see the guard in `server/test/setup.ts`).
 */
import './test/setup.js';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'crypto';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import type { ActiveChatProcess } from './active-chat-process.js';
import { getStmts } from './db.js';
import createChatHandler, { type ChatHandlerDeps } from './chat.js';
import { _resetEphemeralBackgroundBashForTesting } from './ephemeral-background-bash.js';
import type { Agent, EnrichedAgent, Project } from './types.js';

vi.mock('./per-user-cli-spawn.js', () => ({
  EngineAuthRequiredError: class EngineAuthRequiredError extends Error {},
  resolveSessionCliSpawnEnv: vi.fn(() => ({})),
}));

const testPrefix = `await-input-${randomUUID().slice(0, 8)}`;
const agentId = `${testPrefix}-agent`;
let tmpRoot: string;

beforeAll(() => {
  tmpRoot = mkdtempSync(path.join(tmpdir(), 'await-input-'));
});

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

beforeEach(() => {
  _resetEphemeralBackgroundBashForTesting();
});

function makeDeps(activeProcesses: Map<string, ActiveChatProcess>, bin: string): ChatHandlerDeps {
  const agent = { id: agentId, name: 'BG target', engine: 'claude-code' } as Agent;
  const project = {
    id: `${testPrefix}-project`,
    name: 'BG target project',
    cwd: tmpRoot,
    ahw: tmpRoot,
    mode: 'dev',
    agents: [],
  } as Project;
  const enriched = {
    id: agentId,
    name: 'BG target',
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
    autoCommitAndPR: vi.fn(async () => undefined),
    tryAutonomousDispatch: vi.fn(),
  };
}

function seedSession(): string {
  const sessionId = `${testPrefix}-session-${randomUUID().slice(0, 8)}`;
  getStmts().createSession.run(sessionId, agentId, 'BG shells', 'claude-code', 'auto', 1, 0, 1);
  return sessionId;
}

async function waitFor(cond: () => boolean, timeoutMs = 10_000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/** Delimiter between recorded prompts — no prompt can contain a NUL byte. */
const PROMPT_SEPARATOR = '\u0000';

/**
 * A fake claude-code CLI: appends the last argv element (the prompt) to a
 * shared record file and optionally replays canned stream-json lines on stdout.
 *
 * Appends rather than overwrites because a single `handleChat` call can spawn
 * the CLI more than once — a ReAct hop, an error retry, or the background-shell
 * recovery continuation. Tests need the whole sequence, not just the last one.
 */
function makeFakeCli(
  streamJsonLines: string[] = [],
  tail = 'cat >/dev/null 2>&1\nexit 0',
): { bin: string; argFile: string } {
  const argFile = path.join(tmpRoot, `${randomUUID()}.args`);
  // The stream lines carry fenced blocks, and backticks inside a shell string
  // would run as command substitution, so replay them from a file instead.
  const streamFile = path.join(tmpRoot, `${randomUUID()}.jsonl`);
  const onceFile = path.join(tmpRoot, `${randomUUID()}.once`);
  const bin = path.join(tmpRoot, `${randomUUID()}-fake-cli.sh`);
  writeFileSync(streamFile, streamJsonLines.map((line) => `${line}\n`).join(''));
  writeFileSync(
    bin,
    `#!/bin/sh\n` +
      `for a in "$@"; do last="$a"; done\n` +
      `printf '%s\\000' "$last" >> "${argFile}"\n` +
      `if [ ! -f "${onceFile}" ]; then\n` +
      `  : > "${onceFile}"\n` +
      `  cat "${streamFile}"\n` +
      `fi\n` +
      `${tail}\n`,
  );
  chmodSync(bin, 0o755);
  return { bin, argFile };
}

function recordedPrompts(argFile: string): string[] {
  if (!existsSync(argFile)) return [];
  return readFileSync(argFile, 'utf8').split(PROMPT_SEPARATOR).slice(0, -1);
}

/**
 * Runs one turn against a fake CLI and returns every prompt the CLI was
 * spawned with, in order. `expectedSpawns` is the number of spawns the turn is
 * expected to produce; the helper waits for that many and then for the session
 * to go quiet, so a continuation dispatched via `setImmediate` is never missed.
 */
async function runTurn(
  sessionId: string,
  content: string,
  streamJsonLines: string[] = [],
  expectedSpawns = 1,
): Promise<string[]> {
  const { bin, argFile } = makeFakeCli(streamJsonLines);
  const activeProcesses = new Map<string, ActiveChatProcess>();
  const { handleChat } = createChatHandler(makeDeps(activeProcesses, bin));

  await handleChat(null, { type: 'chat', agentId, sessionId, content });
  await waitFor(() => recordedPrompts(argFile).length >= expectedSpawns);
  await waitFor(() => activeProcesses.size === 0);
  // A continuation is dispatched from `setImmediate` after the process map
  // empties, so "empty once" is not "done". Require it to stay empty.
  await new Promise((resolve) => setTimeout(resolve, 250));
  await waitFor(() => activeProcesses.size === 0);

  return recordedPrompts(argFile);
}

/** Claude stream-json for one `Bash` tool call. */
function bashToolUseLine(
  command: string,
  background: boolean,
  description?: string,
  toolUseId = `toolu_${randomUUID().slice(0, 8)}`,
): string {
  return JSON.stringify({
    type: 'assistant',
    message: {
      content: [
        {
          type: 'tool_use',
          id: toolUseId,
          name: 'Bash',
          input: {
            command,
            description,
            ...(background ? { run_in_background: true } : {}),
          },
        },
      ],
    },
  });
}

function textLine(text: string): string {
  return JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text }] } });
}

const ASK_TEXT = [
  'Which environment should I use?',
  '```agenthub:ask',
  JSON.stringify({
    askId: 'env-pick',
    question: 'Which environment?',
    header: 'Env',
    options: [
      { label: 'dev', description: 'Dev stack' },
      { label: 'prod', description: 'Production' },
    ],
  }),
  '```',
].join('\n');

const CREDENTIAL_TEXT = [
  'I need your login.',
  '```agenthub:credential-request',
  JSON.stringify({
    requestId: 'tracker-login',
    service: 'Tracker',
    purpose: 'Sign in',
    fields: [{ key: 'password', label: 'Password', type: 'password' }],
  }),
  '```',
].join('\n');

interface Row {
  role: string;
  content: string;
  metadata: string | null;
}

describe('a turn that asks the user for input stops the session', () => {
  it('does not dispatch a host continuation after an ask picker', async () => {
    const sessionId = seedSession();
    // Without the gate, the dangling background shell alone schedules a
    // recovery continuation that runs without the user's answer.
    const prompts = await runTurn(sessionId, 'Deploy it.', [
      textLine(ASK_TEXT),
      bashToolUseLine('npm run build', true, 'Build'),
    ]);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(prompts).toHaveLength(1);
    // The parser lifts the fence out of the saved text, so the row carries a
    // metadata stamp that the background-shell watcher reads.
    const messages = getStmts().getMessages.all(sessionId) as Row[];
    const assistant = messages.filter((m) => m.role === 'assistant');
    expect(assistant).toHaveLength(1);
    expect(JSON.parse(assistant[0].metadata ?? '{}').awaitingUserInput).toBe(true);
  });

  it('stops a run that keeps calling tools after requesting a credential', async () => {
    const sessionId = seedSession();
    const { bin, argFile } = makeFakeCli(
      [textLine(CREDENTIAL_TEXT), bashToolUseLine('sleep 60', false, 'Wait')],
      'exec sleep 60',
    );

    const activeProcesses = new Map<string, ActiveChatProcess>();
    const { handleChat } = createChatHandler(makeDeps(activeProcesses, bin));
    const started = Date.now();
    await handleChat(null, { type: 'chat', agentId, sessionId, content: 'Check my tickets.' });
    await waitFor(() => recordedPrompts(argFile).length >= 1);
    await waitFor(() => activeProcesses.size === 0, 15_000);
    await new Promise((resolve) => setTimeout(resolve, 300));

    expect(Date.now() - started).toBeLessThan(20_000);
    expect(recordedPrompts(argFile)).toHaveLength(1);

    const messages = getStmts().getMessages.all(sessionId) as Row[];
    const assistant = messages.filter((m) => m.role === 'assistant');
    expect(assistant).toHaveLength(1);
    expect(assistant[0].content).toContain('agenthub:credential-request');
    expect(
      messages.some((m) => m.role === 'system' && m.metadata?.includes('awaiting_user_input_halt')),
    ).toBe(true);
    expect(messages.some((m) => m.content.startsWith('Run cancelled'))).toBe(false);
    const session = getStmts().getSession.get(sessionId) as { last_turn_error: string | null };
    expect(session.last_turn_error).toBeNull();
  });

  it('lets a run that did not ask anything finish normally', async () => {
    const sessionId = seedSession();
    const prompts = await runTurn(sessionId, 'Read it.', [
      textLine('Reading the file now.'),
      bashToolUseLine('cat README.md', false),
    ]);
    expect(prompts).toHaveLength(1);
    const messages = getStmts().getMessages.all(sessionId) as Row[];
    expect(messages.some((m) => m.metadata?.includes('awaiting_user_input_halt'))).toBe(false);
  });
});
