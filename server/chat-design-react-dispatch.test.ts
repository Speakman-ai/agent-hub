/**
 * End-to-end wiring for the ReAct `design` tool dispatch in chat.ts.
 *
 * The unit tests in design-react.test.ts prove `runDesignReActStep` writes the
 * artifact and returns a screenshot data URL, but they never exercise the
 * `createChatHandler` design branch — so a regression that removed the parse
 * branch or the dispatch handler (the `buildBrowserActivityScreenshotBroadcast`
 * wiring) would leave those green. This test drives a full chat turn whose CLI
 * emits a `<agenthub:react>` design block and asserts the two things the branch
 * is responsible for: the artifact is persisted, and the browser-activity
 * screenshot is broadcast to the client.
 *
 * The Chromium render is injected via the `renderDesign` dep (returns a canned
 * base64), so no real browser launches — same argv-recording fake CLI pattern
 * as chat-ephemeral-background-bash-wiring.test.ts (no real `claude` spawns).
 */
import './test/setup.js';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'crypto';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import config from './config.js';
import { getStmts } from './db.js';
import createChatHandler, { type ChatHandlerDeps } from './chat.js';
import { resolveDesignRenderLocation, DESIGN_RENDER_FILENAME } from './design-react.js';
import type { ActiveChatProcess } from './active-chat-process.js';
import type { Agent, EnrichedAgent, Project, SessionRow } from './types.js';

vi.mock('./per-user-cli-spawn.js', () => ({
  EngineAuthRequiredError: class EngineAuthRequiredError extends Error {},
  resolveSessionCliSpawnEnv: vi.fn(() => ({})),
}));

const testPrefix = `design-dispatch-${randomUUID().slice(0, 8)}`;
const agentId = `${testPrefix}-agent`;
let tmpRoot: string;

// 1x1 transparent PNG base64 — enough for the injected render + screenshot store.
const TINY_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

beforeAll(() => {
  tmpRoot = mkdtempSync(path.join(tmpdir(), 'design-dispatch-'));
});

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
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
  const agent = { id: agentId, name: 'Design target', engine: 'claude-code' } as Agent;
  const project = {
    id: `${testPrefix}-project`,
    name: 'Design target project',
    cwd: tmpRoot,
    ahw: tmpRoot,
    mode: 'dev',
    agents: [],
  } as Project;
  const enriched = {
    id: agentId,
    name: 'Design target',
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
    // Injected so no real Chromium launches; returns a canned screenshot.
    renderDesign: async (_sessionId: string, html: string) => {
      captured.renderCalls.push(html);
      return { ok: true, imageBase64: TINY_B64, mime: 'image/png' };
    },
    autoCommitAndPR: vi.fn(async () => undefined),
    tryAutonomousDispatch: vi.fn(),
  };
}

/**
 * Fake claude-code CLI: streams the given stdout lines on its FIRST spawn only
 * (a ReAct continuation re-runs the same script and must not re-emit the block,
 * or the turn never settles).
 */
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

function seedSession(): string {
  const sessionId = `${testPrefix}-session-${randomUUID().slice(0, 8)}`;
  // (id, agent_id, name, engine, model, use_worktree, ask_mode, wiki_hybrid_rag_budget_version)
  getStmts().createSession.run(sessionId, agentId, 'Design', 'claude-code', 'auto', 1, 0, 1);
  return sessionId;
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

describe('chat handler — design ReAct tool dispatch', () => {
  it('renders a submitted design action: persists the artifact and broadcasts the screenshot', async () => {
    const sessionId = seedSession();
    const html = '<h1>Design Dispatch Test</h1>';
    const reactBlock = `<agenthub:react>${JSON.stringify({
      actions: [{ tool: 'design', op: 'render', html }],
    })}</agenthub:react>`;

    const captured: Captured = { broadcasts: [], renderCalls: [] };
    const activeProcesses = new Map<string, ActiveChatProcess>();
    const bin = makeFakeCli([assistantTextLine(reactBlock)]);
    const { handleChat } = createChatHandler(makeDeps(activeProcesses, bin, captured));

    await handleChat(null, { type: 'chat', agentId, sessionId, content: 'Show me a chart.' });

    // The dispatch handler ran: the render was invoked and a screenshot
    // broadcast was emitted to the client.
    await waitFor(() => captured.broadcasts.some((m) => m.type === 'browser_activity_screenshot'));
    // Let the auto-continuation spawn settle so no process is left running.
    await waitFor(() => activeProcesses.size === 0);
    await new Promise((resolve) => setTimeout(resolve, 200));

    // 1. The dispatcher wired the render through with the wrapped document.
    expect(captured.renderCalls.length).toBeGreaterThanOrEqual(1);
    expect(captured.renderCalls[0]).toContain(html);

    // 2. The browser-activity screenshot broadcast carries the design op's image.
    const shot = captured.broadcasts.find((m) => m.type === 'browser_activity_screenshot');
    expect(shot).toBeTruthy();
    expect(shot?.sessionId).toBe(sessionId);
    expect(String(shot?.screenshotDataUrl)).toContain('data:image/png;base64,');

    // 3. The artifact was persisted to the served design location.
    const session = getStmts().getSession.get(sessionId) as SessionRow | undefined;
    const loc = resolveDesignRenderLocation({
      worktreePath: session?.worktree_path,
      sessionId,
      dataDir: config.dataDir,
    });
    const artifact = path.join(loc.root, DESIGN_RENDER_FILENAME);
    expect(existsSync(artifact)).toBe(true);
    expect(readFileSync(artifact, 'utf8')).toContain(html);

    // Clean up a data-dir artifact written outside the test tmp root.
    if (loc.kind === 'data-dir') rmSync(loc.root, { recursive: true, force: true });
  });
});
