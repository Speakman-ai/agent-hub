/**
 * End-to-end wiring for the ReAct `approval` tool in chat.ts: an approval that
 * is not granted must stop the actions the model queued after it in the same
 * batch, so the guarded operation never runs before the model sees the denial.
 *
 * A fake claude-code CLI emits `[approval(request), design(render)]`. The
 * design render is the side-effecting probe: it is injected via the
 * `renderDesign` dep, so a call means the action after the approval ran. No
 * real CLI or Chromium launches (same pattern as chat-design-react-dispatch).
 */
import './test/setup.js';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'crypto';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { getStmts } from './db.js';
import { initOrgsDb, setOrgsDbPathForTests } from './orgs.js';
import createChatHandler, { type ChatHandlerDeps } from './chat.js';
import {
  APPROVAL_REQUESTED_EVENT,
  APPROVAL_TIMEOUT_MS,
  __resetApprovalWaitersForTests,
  answerApprovalRequest,
  type ApprovalDecision,
} from './approval-requests.js';
import type { ActiveChatProcess } from './active-chat-process.js';
import type { Agent, EnrichedAgent, Project } from './types.js';

vi.mock('./per-user-cli-spawn.js', () => ({
  EngineAuthRequiredError: class EngineAuthRequiredError extends Error {},
  resolveSessionCliSpawnEnv: vi.fn(() => ({})),
}));

const testPrefix = `approval-dispatch-${randomUUID().slice(0, 8)}`;
const agentId = `${testPrefix}-agent`;
let tmpRoot: string;

const TINY_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

beforeAll(() => {
  tmpRoot = mkdtempSync(path.join(tmpdir(), 'approval-dispatch-'));
  setOrgsDbPathForTests(path.join(tmpRoot, 'orgs.db'));
  initOrgsDb();
});

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

afterEach(() => {
  __resetApprovalWaitersForTests();
});

interface Captured {
  broadcasts: Array<Record<string, unknown>>;
  renderCalls: string[];
}

function makeDeps(
  activeProcesses: Map<string, ActiveChatProcess>,
  bin: string,
  captured: Captured,
): ChatHandlerDeps {
  const agent = { id: agentId, name: 'Approval target', engine: 'claude-code' } as Agent;
  const project = {
    id: `${testPrefix}-project`,
    name: 'Approval target project',
    cwd: tmpRoot,
    ahw: tmpRoot,
    mode: 'dev',
    agents: [],
  } as Project;
  const enriched = {
    id: agentId,
    name: 'Approval target',
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
    renderDesign: async (_sessionId: string, html: string) => {
      captured.renderCalls.push(html);
      return { ok: true, imageBase64: TINY_B64, mime: 'image/png' };
    },
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

/**
 * Run one turn whose CLI asks for approval then renders a design, answer the
 * approval with `answer`, and return what happened.
 */
async function runTurn(answer: (approvalId: string) => void) {
  const sessionId = `${testPrefix}-session-${randomUUID().slice(0, 8)}`;
  getStmts().createSession.run(sessionId, agentId, 'Approval', 'claude-code', 'auto', 1, 0, 1);
  const html = '<h1>Guarded side effect</h1>';
  const reactBlock = `<agenthub:react>${JSON.stringify({
    actions: [
      {
        tool: 'approval',
        op: 'request',
        action: 'publish',
        target: 'https://blog.example.com/post/1',
      },
      { tool: 'design', op: 'render', html },
    ],
  })}</agenthub:react>`;

  const captured: Captured = { broadcasts: [], renderCalls: [] };
  const activeProcesses = new Map<string, ActiveChatProcess>();
  const bin = makeFakeCli([assistantTextLine(reactBlock)]);
  const { handleChat } = createChatHandler(makeDeps(activeProcesses, bin, captured));

  await handleChat(null, { type: 'chat', agentId, sessionId, content: 'Publish the post.' });

  await waitFor(() => captured.broadcasts.some((m) => m.type === APPROVAL_REQUESTED_EVENT));
  const requested = captured.broadcasts.find((m) => m.type === APPROVAL_REQUESTED_EVENT)!;
  const approvalId = (requested.approval as { id: string }).id;
  // The turn is parked on the approval: nothing after it has run yet.
  expect(captured.renderCalls).toHaveLength(0);

  answer(approvalId);

  const hostSteps = () =>
    captured.broadcasts.filter(
      (m) => m.type === 'react_loop_step' && (m as { phase?: unknown }).phase === 'host_action',
    );
  await waitFor(() => hostSteps().some((m) => (m as { tool?: unknown }).tool === 'approval'));
  await waitFor(() => activeProcesses.size === 0);
  await new Promise((resolve) => setTimeout(resolve, 200));
  return { captured, html, hostSteps: hostSteps() };
}

function answerWith(decision: ApprovalDecision) {
  return (id: string) => {
    expect(answerApprovalRequest(id, decision, null).ok).toBe(true);
  };
}

describe('chat handler — approval ReAct tool halts the batch', () => {
  it('a denial stops the side-effecting action queued after it', async () => {
    const { captured, hostSteps } = await runTurn(answerWith('deny'));
    expect(captured.renderCalls).toHaveLength(0);
    expect(hostSteps.map((m) => (m as { tool?: unknown }).tool)).toEqual(['approval']);
  });

  it('a timeout stops the side-effecting action queued after it', async () => {
    const { captured } = await runTurn((id) => {
      // An answer after the 24h deadline settles the request as a timeout.
      const late = answerApprovalRequest(id, 'allow_once', null, Date.now() + APPROVAL_TIMEOUT_MS);
      expect(late).toMatchObject({ ok: false, code: 'expired' });
    });
    expect(captured.renderCalls).toHaveLength(0);
  });

  it('an allowed approval lets the queued action run', async () => {
    const { captured, html } = await runTurn(answerWith('allow_once'));
    expect(captured.renderCalls).toHaveLength(1);
    expect(captured.renderCalls[0]).toContain(html);
  });
});
