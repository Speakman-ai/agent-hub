/**
 * End-to-end wiring for the "Runs don't survive" fix (support ticket a441b013).
 *
 * Turn N's CLI emits a `Bash` tool_use with `run_in_background: true`; that
 * shell dies with the CLI process when the turn ends. Turn N+1 must lead with
 * that fact so the agent stops waiting on output nothing will produce.
 *
 * Uses the argv-recording fake CLI pattern from
 * `chat-forwarded-context-bootstrap.test.ts` — no real `claude` is ever spawned
 * (see the guard in `server/test/setup.ts`).
 */
import './test/setup.js';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'crypto';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import type { ChildProcess } from 'child_process';
import { getStmts } from './db.js';
import createChatHandler, { type ChatHandlerDeps } from './chat.js';
import { _resetEphemeralBackgroundBashForTesting } from './ephemeral-background-bash.js';
import type { Agent, EnrichedAgent, Project } from './types.js';

vi.mock('./per-user-cli-spawn.js', () => ({
  EngineAuthRequiredError: class EngineAuthRequiredError extends Error {},
  resolveSessionCliSpawnEnv: vi.fn(() => ({})),
}));

const testPrefix = `bg-bash-${randomUUID().slice(0, 8)}`;
const agentId = `${testPrefix}-agent`;
let tmpRoot: string;

beforeAll(() => {
  tmpRoot = mkdtempSync(path.join(tmpdir(), 'bg-bash-wiring-'));
});

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

beforeEach(() => {
  _resetEphemeralBackgroundBashForTesting();
});

function makeDeps(activeProcesses: Map<string, ChildProcess>, bin: string): ChatHandlerDeps {
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

/**
 * A fake claude-code CLI: records the last argv element (the prompt) and
 * optionally replays canned stream-json lines on stdout.
 */
function makeFakeCli(streamJsonLines: string[] = []): { bin: string; argFile: string } {
  const argFile = path.join(tmpRoot, `${randomUUID()}.args`);
  const bin = path.join(tmpRoot, `${randomUUID()}-fake-cli.sh`);
  const emit = streamJsonLines.map((line) => `printf '%s\\n' ${JSON.stringify(line)}`).join('\n');
  writeFileSync(
    bin,
    `#!/bin/sh\nfor a in "$@"; do last="$a"; done\nprintf '%s' "$last" > "${argFile}"\n${emit}\ncat >/dev/null 2>&1\nexit 0\n`,
  );
  chmodSync(bin, 0o755);
  return { bin, argFile };
}

/** Runs one turn against a fake CLI and returns the prompt argv element. */
async function runTurn(
  sessionId: string,
  content: string,
  streamJsonLines: string[] = [],
): Promise<string> {
  const { bin, argFile } = makeFakeCli(streamJsonLines);
  const activeProcesses = new Map<string, ChildProcess>();
  const { handleChat } = createChatHandler(makeDeps(activeProcesses, bin));

  await handleChat(null, { type: 'chat', agentId, sessionId, content });
  await waitFor(() => existsSync(argFile));
  await waitFor(() => activeProcesses.size === 0);

  return readFileSync(argFile, 'utf8');
}

/**
 * Runs one turn against a CLI path that does not exist, so `spawn` emits
 * `error` and never `spawn`. Returns nothing — the point is the side effect.
 */
async function runTurnWithFailedSpawn(sessionId: string, content: string): Promise<void> {
  const activeProcesses = new Map<string, ChildProcess>();
  const missingBin = path.join(tmpRoot, `${randomUUID()}-does-not-exist`);
  const { handleChat } = createChatHandler(makeDeps(activeProcesses, missingBin));
  await handleChat(null, { type: 'chat', agentId, sessionId, content });
  await waitFor(() => activeProcesses.size === 0);
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

describe('native background Bash shells across turns', () => {
  // The reported failure: a ~5 minute pytest run parked in a background shell,
  // a scheduled wakeup, and a next turn that found a dead handle with no
  // explanation. The notice is what turns that into a one-line correction.
  it('tells the next turn which background shells the previous CLI took down', async () => {
    const sessionId = seedSession();

    await runTurn(sessionId, 'Run the regression suite.', [
      bashToolUseLine('docker exec dwgskip-app pytest dwg_parse', true, 'Run regression test'),
    ]);

    const nextPrompt = await runTurn(sessionId, 'so?');

    expect(nextPrompt).toContain('A background Bash shell you started in a previous turn is');
    expect(nextPrompt).toContain('docker exec dwgskip-app pytest dwg_parse');
    expect(nextPrompt).toContain('bg.sh start');
    // The user's actual message must still be there, after the notice.
    expect(nextPrompt).toContain('so?');
    expect(nextPrompt.indexOf('bg.sh start')).toBeLessThan(nextPrompt.lastIndexOf('so?'));
  });

  it('warns only once — the turn after that is clean', async () => {
    const sessionId = seedSession();
    await runTurn(sessionId, 'Start the build.', [bashToolUseLine('npm run build', true)]);
    await runTurn(sessionId, 'status?');

    const third = await runTurn(sessionId, 'and now?');
    expect(third).not.toContain('bg.sh start');
  });

  // Reviewer finding: consuming the records before the CLI is up loses the
  // warning when the spawn fails, so the retry that works gets no explanation.
  it('survives a failed spawn and warns on the next attempt', async () => {
    const sessionId = seedSession();
    await runTurn(sessionId, 'Start the build.', [bashToolUseLine('npm run build', true)]);

    await runTurnWithFailedSpawn(sessionId, 'status?');

    const retry = await runTurn(sessionId, 'status?');
    expect(retry).toContain('npm run build');
    expect(retry).toContain('bg.sh start');
  });

  // Reviewer finding: a shell watched to completion inside the turn must not be
  // reported as lost, or the agent redoes work that already finished.
  it('stays silent about a shell whose BashOutput reported completion', async () => {
    const sessionId = seedSession();
    const launchId = 'toolu_launch_1';

    await runTurn(sessionId, 'Run the suite.', [
      bashToolUseLine('npm test', true, 'Run suite', launchId),
      JSON.stringify({
        type: 'user',
        message: {
          content: [
            {
              type: 'tool_result',
              tool_use_id: launchId,
              content: 'Command running in background with ID: bash_1',
            },
          ],
        },
      }),
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              id: 'toolu_poll_1',
              name: 'BashOutput',
              input: { bash_id: 'bash_1' },
            },
          ],
        },
      }),
      JSON.stringify({
        type: 'user',
        message: {
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'toolu_poll_1',
              content: '<status>completed</status>\n<exit_code>0</exit_code>\nall green',
            },
          ],
        },
      }),
    ]);

    const nextPrompt = await runTurn(sessionId, 'so?');
    expect(nextPrompt).not.toContain('no longer reachable');
    expect(nextPrompt).not.toContain('bg.sh start');
  });

  // Reviewer finding: a denied/failed launch returns no parseable shell id, the
  // same shape as a successful launch we could not parse. Without the is_error
  // signal the next turn warns about a shell that never existed.
  it('stays silent about a background launch the CLI rejected', async () => {
    const sessionId = seedSession();
    const launchId = 'toolu_denied_1';

    await runTurn(sessionId, 'Wipe the disk.', [
      bashToolUseLine('rm -rf /', true, 'Wipe disk', launchId),
      JSON.stringify({
        type: 'user',
        message: {
          content: [
            {
              type: 'tool_result',
              tool_use_id: launchId,
              is_error: true,
              content: 'Permission to use Bash with command rm -rf / has been denied.',
            },
          ],
        },
      }),
    ]);

    const nextPrompt = await runTurn(sessionId, 'so?');
    expect(nextPrompt).not.toContain('no longer reachable');
    expect(nextPrompt).not.toContain('rm -rf /');
    expect(nextPrompt).not.toContain('bg.sh start');
  });

  it('stays silent when the turn only ran foreground Bash', async () => {
    const sessionId = seedSession();
    await runTurn(sessionId, 'List the files.', [bashToolUseLine('ls -la', false)]);

    const nextPrompt = await runTurn(sessionId, 'anything interesting?');
    expect(nextPrompt).not.toContain('background Bash shell');
    expect(nextPrompt).not.toContain('bg.sh start');
  });
});
