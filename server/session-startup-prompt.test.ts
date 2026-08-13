/**
 * Session startup setup section in the enriched prompt.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync } from 'fs';
import path from 'path';
import os from 'os';
import {
  __resetSessionStartupStatusForTests,
  type SessionStartupStatus,
} from './session-env/session-startup-hooks.js';

const tmpBase = path.join(os.tmpdir(), `session-startup-prompt-${Date.now()}`);

const projectState: { sessionStartupCommands?: string[] } = {};

vi.mock('./db.js', () => ({
  db: {},
  stmts: {
    getAgentSkillOverrides: { all: () => [] },
  },
}));

vi.mock('./wiki.js', () => ({
  getWikiContext: () => '',
}));

vi.mock('./routes/skills.js', () => ({
  collectSkillsFromDir: () => [],
  DEFAULT_SKILLS_DIR: '/tmp/no-default-skills',
}));

vi.mock('./config.js', () => ({
  default: { defaultModel: 'claude-sonnet-4-20250514' },
  defaultModelForEngine: () => 'claude-sonnet-4-20250514',
  buildSpawnEnv: () => ({}),
}));

vi.mock('./project-paths.js', () => ({
  resolveProjectPaths: () => ({
    skillsDir: path.join(tmpBase, 'project-skills'),
    contextFiles: {},
  }),
  contextFilePath: () => null,
}));

vi.mock('./project-model.js', () => ({
  allAgents: () => [],
  findProject: () => ({
    id: 'test-proj',
    name: 'Test Project',
    cwd: tmpBase,
    ahw: tmpBase,
    agents: [],
    sessionStartupCommands: projectState.sessionStartupCommands,
  }),
}));

vi.mock('./session-env/session-startup-hooks.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./session-env/session-startup-hooks.js')>();
  return {
    ...actual,
    getSessionStartupStatus: (sessionId: string): SessionStartupStatus | null =>
      actual.getSessionStartupStatus(sessionId),
  };
});

import { buildEnrichedPrompt } from './chat.js';
import { runSessionStartupHooks } from './session-env/session-startup-hooks.js';
import type { SessionEnv } from './session-env/session-env.js';
import type { SessionWorktreeIo } from './session-env/worktree-io.js';

function makeProject() {
  return {
    id: 'test-proj',
    name: 'Test Project',
    cwd: tmpBase,
    ahw: tmpBase,
    agents: [],
    sessionStartupCommands: projectState.sessionStartupCommands,
  };
}

function makeAgent() {
  return {
    id: 'test-agent',
    name: 'Test Agent',
    engine: 'claude-code',
    systemPrompt: 'You are a test agent.',
    role: 'member' as const,
  };
}

describe('buildEnrichedPrompt — session startup setup', () => {
  beforeEach(() => {
    mkdirSync(tmpBase, { recursive: true });
    __resetSessionStartupStatusForTests();
    projectState.sessionStartupCommands = undefined;
  });

  afterEach(() => {
    rmSync(tmpBase, { recursive: true, force: true });
  });

  it('omits the section when the project has no startup commands', () => {
    const prompt = buildEnrichedPrompt(makeProject() as never, makeAgent() as never, {
      sessionId: 'sess-1',
      isFirstMessage: true,
    });
    expect(prompt).not.toContain('Session Startup Setup');
  });

  it('includes pending guidance when commands are configured but status is unset', () => {
    projectState.sessionStartupCommands = ['python3 -m venv .venv'];
    const prompt = buildEnrichedPrompt(makeProject() as never, makeAgent() as never, {
      sessionId: 'sess-1',
      isFirstMessage: true,
    });
    expect(prompt).toContain('Session Startup Setup');
    expect(prompt).toContain('pending');
  });

  it('reflects a ready status from the registry', async () => {
    projectState.sessionStartupCommands = ['echo ready'];
    const io: SessionWorktreeIo = {
      sharing: 'host-shared',
      hostPath: tmpBase,
      git: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
      exec: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
      readFile: async () => Buffer.from(''),
      writeFile: async () => {},
      downloadFile: async () => {},
      listDir: async () => [],
      stat: async () => null,
      exists: async () => false,
    };
    const env = {
      worktreeIo: io,
      kind: 'host',
      spawn: () => {
        const proc = {
          pid: 1,
          name: 'echo',
          exited: false,
          exitResult: null as { code: number; signal: null } | null,
          onStdout: () => () => {},
          onStderr: () => () => {},
          onExit: (cb: (e: { code: number; signal: null }) => void) => {
            queueMicrotask(() => {
              const e = { code: 0, signal: null as null };
              proc.exited = true;
              proc.exitResult = e;
              cb(e);
            });
            return () => {};
          },
          kill: () => {},
        };
        return proc;
      },
    } as unknown as SessionEnv;
    await runSessionStartupHooks({
      sessionId: 'sess-1',
      env,
      commands: ['echo ready'],
    });
    const prompt = buildEnrichedPrompt(makeProject() as never, makeAgent() as never, {
      sessionId: 'sess-1',
      isFirstMessage: true,
    });
    expect(prompt).toContain('Session Startup Setup');
    expect(prompt).toContain('**ready**');
    expect(prompt).toContain('echo ready');
  });
});
