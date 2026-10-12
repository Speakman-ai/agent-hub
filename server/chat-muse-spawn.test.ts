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

vi.mock('./per-user-cli-spawn.js', () => ({
  EngineAuthRequiredError: class EngineAuthRequiredError extends Error {},
  resolveSessionCliSpawnEnv: vi.fn(() => ({})),
}));

const prefix = `muse-spawn-${randomUUID().slice(0, 8)}`;
let tmpRoot: string;

beforeAll(() => {
  tmpRoot = mkdtempSync(path.join(tmpdir(), 'muse-spawn-'));
});

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

/**
 * Stand-in for the `muse` binary: records argv and the prompt file, then
 * prints the minimal `muse exec --json` stream for the session id it was given.
 * The file is not named `muse`, so the test CLI guard does not trip.
 */
function writeFakeMuse(recordDir: string): string {
  const bin = path.join(tmpRoot, `fake-muse-${randomUUID()}.sh`);
  writeFileSync(
    bin,
    `#!/bin/sh
n=$(ls "${recordDir}" | grep -c '\\.args$')
printf "%s\\n" "$@" > "${recordDir}/$n.args"
sid=""; pf=""
while [ $# -gt 0 ]; do
  case "$1" in
    --session-id) sid="$2"; shift ;;
    --prompt-file) pf="$2"; shift ;;
  esac
  shift
done
cat "$pf" > "${recordDir}/$n.prompt"
printf '{"stream":{"kind":"session","id":"%s"},"payload_type":"run.output.delta","payload":{"text":"done"}}\\n' "$sid"
printf '{"stream":{"kind":"session","id":"%s"},"payload_type":"run.terminal.completed","payload":{"terminal":"completed","text":"done"}}\\n' "$sid"
`,
  );
  chmodSync(bin, 0o755);
  return bin;
}

function makeDeps(
  agentId: string,
  activeProcesses: Map<string, ActiveChatProcess>,
  museBin: string,
): ChatHandlerDeps {
  const agent = { id: agentId, name: 'Muse agent', engine: 'muse-code' } as Agent;
  const project = {
    id: `${prefix}-project`,
    name: 'Muse project',
    cwd: tmpRoot,
    ahw: tmpRoot,
    mode: 'dev',
    agents: [],
  } as Project;
  const enriched = {
    id: agentId,
    name: 'Muse agent',
    engine: 'muse-code',
    projectId: project.id,
    cwd: tmpRoot,
    ahw: tmpRoot,
    workspace: tmpRoot,
  } as EnrichedAgent;
  const unused = () => '/nonexistent';
  return {
    broadcast: () => {},
    createCursorChat: undefined,
    findAgent: (id) => (id === agentId ? { project, agent } : null),
    getEnrichedAgent: (id) => (id === agentId ? enriched : null),
    activeProcesses,
    autonomousProjects: new Set(),
    getClaudeBin: unused,
    getCursorBin: unused,
    getGeminiBin: unused,
    getCodexBin: unused,
    getGrokBin: unused,
    getMuseBin: () => museBin,
    uploadsDir: tmpRoot,
    resolveSlashSkill: vi.fn(),
    ensureWorktree: vi.fn(async () => tmpRoot),
    drainQueue: vi.fn(),
    autoCommitAndPR: vi.fn(async () => undefined),
    tryAutonomousDispatch: vi.fn(),
  };
}

async function waitFor(cond: () => boolean, timeoutMs = 5_000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

describe('muse-code chat spawn', () => {
  it('creates a Muse session on turn one and resumes the same id on turn two', async () => {
    const recordDir = mkdtempSync(path.join(tmpRoot, 'record-'));
    const agentId = `${prefix}-agent`;
    const sessionId = `${prefix}-session`;
    getStmts().createSession.run(
      sessionId,
      agentId,
      'muse test',
      'muse-code',
      'muse-spark-1.2',
      1,
      0,
      1,
    );

    const activeProcesses = new Map<string, ActiveChatProcess>();
    const { handleChat } = createChatHandler(
      makeDeps(agentId, activeProcesses, writeFakeMuse(recordDir)),
    );
    const runTurn = async (content: string, n: number) => {
      await handleChat(null, { type: 'chat', agentId, sessionId, content });
      await waitFor(() => existsSync(path.join(recordDir, `${n}.prompt`)));
      await waitFor(() => activeProcesses.size === 0);
      return {
        args: readFileSync(path.join(recordDir, `${n}.args`), 'utf8')
          .trimEnd()
          .split('\n'),
        prompt: readFileSync(path.join(recordDir, `${n}.prompt`), 'utf8'),
      };
    };

    const first = await runTurn('Fix the login bug', 0);
    expect(first.args.slice(0, 2)).toEqual(['exec', '--json']);
    expect(first.args).toEqual(expect.arrayContaining(['--yolo', '--user-input-auto-resolve']));
    expect(first.args[first.args.indexOf('--model') + 1]).toBe('muse-spark-1.2');
    const museSessionId = first.args[first.args.indexOf('--session-id') + 1];
    expect(museSessionId).toMatch(/^[0-9a-f-]{36}$/);
    // Turn one carries the Hub rules ahead of the user's message.
    expect(first.prompt.length).toBeGreaterThan('Fix the login bug'.length * 10);
    expect(first.prompt).toContain('Fix the login bug');

    await waitFor(
      () =>
        (getStmts().getSession.get(sessionId) as SessionRow | undefined)?.engine_session_id ===
        museSessionId,
    );

    const second = await runTurn('Now add a test', 1);
    expect(second.args[second.args.indexOf('--session-id') + 1]).toBe(museSessionId);
    // Muse's own session store holds the Hub rules, so turn two sends only the turn.
    expect(second.prompt.trim()).toBe('Now add a test');

    const assistant = (getStmts().getMessages.all(sessionId) as MessageRow[]).filter(
      (m) => m.role === 'assistant',
    );
    expect(assistant.at(-1)?.content).toBe('done');
  });
});
