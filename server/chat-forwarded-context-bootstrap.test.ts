import './test/setup.js';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'crypto';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import type { ChildProcess } from 'child_process';
import { getStmts } from './db.js';
import createChatHandler, { type ChatHandlerDeps } from './chat.js';
import { SAFE_ARG_STRLEN_BYTES } from './spawn-prompt-payload.js';
import type { Agent, EnrichedAgent, Project } from './types.js';

vi.mock('./per-user-cli-spawn.js', () => ({
  EngineAuthRequiredError: class EngineAuthRequiredError extends Error {},
  resolveSessionCliSpawnEnv: vi.fn(() => ({})),
}));

const testPrefix = `fwd-bootstrap-${randomUUID().slice(0, 8)}`;
const agentId = `${testPrefix}-agent`;
let tmpRoot: string;

beforeAll(() => {
  tmpRoot = mkdtempSync(path.join(tmpdir(), 'fwd-bootstrap-'));
});

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

function makeDeps(activeProcesses: Map<string, ChildProcess>, bin: string): ChatHandlerDeps {
  const agent = { id: agentId, name: 'Forward target', engine: 'claude-code' } as Agent;
  const project = {
    id: `${testPrefix}-project`,
    name: 'Forward target project',
    cwd: tmpRoot,
    ahw: tmpRoot,
    mode: 'dev',
    agents: [],
  } as Project;
  const enriched = {
    id: agentId,
    name: 'Forward target',
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

/** Mirrors what `POST /api/sessions/:id/forward` stores when `autoStart` is false. */
function forwardedContent(transcriptBytes: number): string {
  return [
    'Take over from here and finish the migration.',
    '',
    '--- Forwarded from session with Survey Tracker Dev ---',
    `[User]:\n${'x'.repeat(transcriptBytes)}`,
    '[Assistant]:\nThe last thing we did was rename the column.',
    '--- End of forwarded context ---',
  ].join('\n');
}

function seedForwardedSession(transcriptBytes: number): string {
  const sessionId = `${testPrefix}-session-${randomUUID().slice(0, 8)}`;
  const stmts = getStmts();
  stmts.createSession.run(
    sessionId,
    agentId,
    '[Fwd] Survey Tracker Dev: work',
    'claude-code',
    'auto',
    1,
    0,
    1,
  );
  stmts.addMessage.run(
    randomUUID(),
    sessionId,
    'user',
    forwardedContent(transcriptBytes),
    null,
    null,
    null,
    null,
    null,
    null,
    null,
  );
  return sessionId;
}

async function waitFor(cond: () => boolean, timeoutMs = 10_000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/** Runs one turn against an argv-recording fake CLI and returns the prompt argv element. */
async function spawnTurnPrompt(sessionId: string, content: string): Promise<string> {
  const argFile = path.join(tmpRoot, `${randomUUID()}.args`);
  const bin = path.join(tmpRoot, `${randomUUID()}-record-argv.sh`);
  writeFileSync(
    bin,
    `#!/bin/sh\nfor a in "$@"; do last="$a"; done\nprintf '%s' "$last" > "${argFile}"\ncat >/dev/null 2>&1\nexit 0\n`,
  );
  chmodSync(bin, 0o755);
  const activeProcesses = new Map<string, ChildProcess>();
  const { handleChat } = createChatHandler(makeDeps(activeProcesses, bin));

  await handleChat(null, { type: 'chat', agentId, sessionId, content });
  await waitFor(() => existsSync(argFile));
  await waitFor(() => activeProcesses.size === 0);

  return readFileSync(argFile, 'utf8');
}

describe('forwarded-context history bootstrap', () => {
  it('inlines a small forwarded transcript on the first turn', async () => {
    const sessionId = seedForwardedSession(500);
    const prompt = await spawnTurnPrompt(sessionId, 'What should I do first?');

    expect(prompt).toContain('Previous conversation:');
    expect(prompt).toContain('--- Forwarded from session with Survey Tracker Dev ---');
    expect(prompt).toContain('Take over from here and finish the migration.');
    expect(prompt).toContain('Human: What should I do first?');
  });

  // Regression: a forwarded transcript larger than the argv soft cap used to
  // be dropped in full, so the target agent saw only the new user message and
  // read as if it had ignored the forward. Both ends must survive the trim.
  it('keeps forwarded context when the transcript exceeds the argv cap', async () => {
    const sessionId = seedForwardedSession(300_000);
    const prompt = await spawnTurnPrompt(sessionId, 'What should I do first?');

    expect(Buffer.byteLength(prompt, 'utf8')).toBeLessThanOrEqual(SAFE_ARG_STRLEN_BYTES);
    expect(prompt).toContain('Previous conversation:');
    expect(prompt).toContain('Take over from here and finish the migration.');
    expect(prompt).toContain('--- Forwarded from session with Survey Tracker Dev ---');
    expect(prompt).toContain('The last thing we did was rename the column.');
    expect(prompt).toContain('omitted from the middle of this message');
    expect(prompt).toContain('Human: What should I do first?');
  });
});
