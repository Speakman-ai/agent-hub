/**
 * End-to-end batch control in chat.ts: once a browser or preview step fails,
 * the page steps the model queued after it in the same `<agenthub:react>`
 * block must not run (they were planned on the assumption the failed step
 * worked). Non-page actions still run.
 *
 * A fake claude-code CLI emits the batch; the browser and preview step
 * runners are mocked, so no real CLI or Chromium launches. The design render
 * (an injected dep) is the non-page probe.
 */
import './test/setup.js';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'crypto';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { getStmts } from './db.js';
import { initOrgsDb, setOrgsDbPathForTests } from './orgs.js';
import createChatHandler, { type ChatHandlerDeps } from './chat.js';
import type { ActiveChatProcess } from './active-chat-process.js';
import type { Agent, EnrichedAgent, Project } from './types.js';

const steps = vi.hoisted(() => ({
  browser: vi.fn(),
  preview: vi.fn(),
}));

vi.mock('./per-user-cli-spawn.js', () => ({
  EngineAuthRequiredError: class EngineAuthRequiredError extends Error {},
  resolveSessionCliSpawnEnv: vi.fn(() => ({})),
}));

vi.mock('./browser-tools.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./browser-tools.js')>()),
  runBrowserReActStep: steps.browser,
}));

vi.mock('./preview/preview-react.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./preview/preview-react.js')>()),
  runPreviewReActStep: steps.preview,
}));

const testPrefix = `batch-dispatch-${randomUUID().slice(0, 8)}`;
const agentId = `${testPrefix}-agent`;
let tmpRoot: string;

const TINY_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

beforeAll(() => {
  tmpRoot = mkdtempSync(path.join(tmpdir(), 'batch-dispatch-'));
  setOrgsDbPathForTests(path.join(tmpRoot, 'orgs.db'));
  initOrgsDb();
});

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

beforeEach(() => {
  steps.browser.mockReset();
  steps.preview.mockReset();
});

const ok = (op: string) => ({ markdown: `## ${op} ok`, hostExit: 0, hostDetail: op });
const failed = (op: string) => ({
  markdown: `## ${op} failed`,
  hostExit: 1,
  hostDetail: `${op}_failed`,
  ui: { summary: `${op} failed`, errorLine: 'boom' },
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
  const agent = { id: agentId, name: 'Batch target', engine: 'claude-code' } as Agent;
  const project = {
    id: `${testPrefix}-project`,
    name: 'Batch target project',
    cwd: tmpRoot,
    ahw: tmpRoot,
    mode: 'dev',
    agents: [],
  } as Project;
  const enriched = {
    id: agentId,
    name: 'Batch target',
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

async function runBatch(actions: unknown[]) {
  const sessionId = `${testPrefix}-session-${randomUUID().slice(0, 8)}`;
  getStmts().createSession.run(sessionId, agentId, 'Batch', 'claude-code', 'auto', 1, 0, 1);
  const reactBlock = `<agenthub:react>${JSON.stringify({ actions })}</agenthub:react>`;
  const captured: Captured = { broadcasts: [], renderCalls: [] };
  const activeProcesses = new Map<string, ActiveChatProcess>();
  const bin = makeFakeCli([assistantTextLine(reactBlock)]);
  const { handleChat } = createChatHandler(makeDeps(activeProcesses, bin, captured));
  await handleChat(null, { type: 'chat', agentId, sessionId, content: 'Fill the form.' });
  await waitFor(() =>
    captured.broadcasts.some(
      (m) => m.type === 'react_loop_step' && (m as { phase?: unknown }).phase === 'host_action',
    ),
  );
  await waitFor(() => activeProcesses.size === 0);
  await new Promise((resolve) => setTimeout(resolve, 200));
  return captured;
}

const opsOf = (fn: typeof steps.browser) => fn.mock.calls.map((c) => (c[1] as { op: string }).op);

describe('chat handler — a failed page step stops the rest of the page batch', () => {
  it('a failed read_page (not just a mutating op) skips the click and select after it', async () => {
    steps.browser.mockImplementation(async (_id: string, input: { op: string }) =>
      input.op === 'read_page' ? failed('read_page') : ok(input.op),
    );
    steps.preview.mockImplementation(async (_id: string, input: { op: string }) => ok(input.op));
    const captured = await runBatch([
      { tool: 'browser', op: 'read_page' },
      { tool: 'browser', op: 'click', target: '#save' },
      { tool: 'preview', op: 'select', target: '#shippingMethod', value: 'Overnight' },
      { tool: 'design', op: 'render', html: '<p>still runs</p>' },
    ]);
    expect(opsOf(steps.browser)).toEqual(['read_page']);
    expect(steps.preview).not.toHaveBeenCalled();
    expect(captured.renderCalls).toHaveLength(1);
  });

  it('a failed preview step skips the browser steps after it', async () => {
    steps.preview.mockImplementation(async (_id: string, input: { op: string }) =>
      failed(input.op),
    );
    steps.browser.mockImplementation(async (_id: string, input: { op: string }) => ok(input.op));
    await runBatch([
      { tool: 'preview', op: 'screenshot' },
      { tool: 'browser', op: 'type', target: '#name', text: 'Ada' },
      { tool: 'browser', op: 'click', target: '#save' },
    ]);
    expect(opsOf(steps.preview)).toEqual(['screenshot']);
    expect(steps.browser).not.toHaveBeenCalled();
  });

  it('when every step succeeds, the whole batch runs in order', async () => {
    steps.browser.mockImplementation(async (_id: string, input: { op: string }) => ok(input.op));
    await runBatch([
      { tool: 'browser', op: 'read_page' },
      { tool: 'browser', op: 'select', target: '#shippingMethod', value: '' },
      { tool: 'browser', op: 'click', target: '#save' },
    ]);
    expect(opsOf(steps.browser)).toEqual(['read_page', 'select', 'click']);
    expect((steps.browser.mock.calls[1][1] as { text?: string }).text).toBe('');
  });
});
