/**
 * End-to-end wiring for the `computer` ReAct tool's session switch in chat.ts:
 * the per-session `computer_tool_enabled` decides whether a `computer` action
 * reaches the desktop runtime, independently of other sessions with the same
 * agent. A fake claude-code CLI emits one click; the runtime is a recording
 * fake, so no real CLI or desktop starts.
 */
import './test/setup.js';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'crypto';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { getDb, getStmts } from './db.js';
import { initOrgsDb, setOrgsDbPathForTests } from './orgs.js';
import createChatHandler, { type ChatHandlerDeps } from './chat.js';
import type { ActiveChatProcess } from './active-chat-process.js';
import type { DesktopInputEvent } from './desktop/desktop-runtime.js';
import type { Agent, EnrichedAgent, Project } from './types.js';

vi.mock('./per-user-cli-spawn.js', () => ({
  EngineAuthRequiredError: class EngineAuthRequiredError extends Error {},
  resolveSessionCliSpawnEnv: vi.fn(() => ({})),
}));

const inputs = vi.hoisted(() => [] as Array<{ userId: string; event: unknown }>);
vi.mock('./desktop/desktop-runtime-setup.js', () => ({
  getActiveDesktopRuntime: () => ({
    kind: 'container',
    input: async (key: { userId: string }, event: unknown) => {
      inputs.push({ userId: key.userId, event });
    },
  }),
}));

const testPrefix = `computer-dispatch-${randomUUID().slice(0, 8)}`;
const agentId = `${testPrefix}-agent`;
let tmpRoot: string;

beforeAll(() => {
  tmpRoot = mkdtempSync(path.join(tmpdir(), 'computer-dispatch-'));
  setOrgsDbPathForTests(path.join(tmpRoot, 'orgs.db'));
  initOrgsDb();
});

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

interface Captured {
  broadcasts: Array<Record<string, unknown>>;
}

function makeDeps(
  activeProcesses: Map<string, ActiveChatProcess>,
  bin: string,
  captured: Captured,
): ChatHandlerDeps {
  const agent = { id: agentId, name: 'Computer target', engine: 'claude-code' } as Agent;
  const project = {
    id: `${testPrefix}-project`,
    name: 'Computer target project',
    cwd: tmpRoot,
    ahw: tmpRoot,
    mode: 'dev',
    agents: [],
  } as Project;
  const enriched = {
    id: agentId,
    name: 'Computer target',
    engine: 'claude-code',
    projectId: project.id,
    cwd: tmpRoot,
    ahw: tmpRoot,
    workspace: tmpRoot,
  } as EnrichedAgent;

  return {
    broadcast: (msg: unknown) => {
      captured.broadcasts.push(msg as Record<string, unknown>);
    },
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

/** Streams the lines on the first spawn only, so the continuation settles. */
function makeFakeCli(streamJsonLines: string[]): string {
  const onceFile = path.join(tmpRoot, `${randomUUID()}.once`);
  const bin = path.join(tmpRoot, `${randomUUID()}-fake-cli.sh`);
  const emit = streamJsonLines.map((line) => `printf '%s\\n' ${JSON.stringify(line)}`).join('\n');
  writeFileSync(
    bin,
    `#!/bin/sh\n` +
      `if [ ! -f "${onceFile}" ]; then\n` +
      `  : > "${onceFile}"\n` +
      `${emit}\n` +
      `fi\n` +
      `cat >/dev/null 2>&1\nexit 0\n`,
  );
  chmodSync(bin, 0o755);
  return bin;
}

function assistantTextLine(text: string): string {
  return JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text }] } });
}

async function waitFor(cond: () => boolean, timeoutMs = 10_000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function runTurn(sessionSwitch: 0 | 1 | null) {
  const sessionId = `${testPrefix}-session-${randomUUID().slice(0, 8)}`;
  getStmts().createSession.run(sessionId, agentId, 'Computer', 'claude-code', 'auto', 1, 0, 1);
  getDb()
    .prepare('UPDATE sessions SET owner_user_id = ?, computer_tool_enabled = ? WHERE id = ?')
    .run(`owner-${sessionId}`, sessionSwitch, sessionId);
  const reactBlock = `<agenthub:react>${JSON.stringify({
    actions: [{ tool: 'computer', op: 'click', x: 10, y: 20 }],
  })}</agenthub:react>`;

  const captured: Captured = { broadcasts: [] };
  const activeProcesses = new Map<string, ActiveChatProcess>();
  const bin = makeFakeCli([assistantTextLine(reactBlock)]);
  const { handleChat } = createChatHandler(makeDeps(activeProcesses, bin, captured));
  await handleChat(null, { type: 'chat', agentId, sessionId, content: 'Click it.' });
  await waitFor(() => activeProcesses.size === 0);
  await new Promise((resolve) => setTimeout(resolve, 200));
  return { owner: `owner-${sessionId}` };
}

describe('chat handler — computer tool session switch', () => {
  it('runs the action only in the session that turned the tool on', async () => {
    const on = await runTurn(1);
    const unset = await runTurn(null);
    const off = await runTurn(0);
    const ran = inputs.map((i) => i.userId);
    expect(ran).toEqual([on.owner]);
    expect(ran).not.toContain(unset.owner);
    expect(ran).not.toContain(off.owner);
    expect(inputs[0]!.event as DesktopInputEvent).toEqual({
      type: 'click',
      x: 10,
      y: 20,
      button: 'left',
    });
  });
});
