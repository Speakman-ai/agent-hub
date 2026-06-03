import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync, existsSync } from 'fs';
import os from 'os';
import path from 'path';

vi.mock('../db.js', () => ({
  db: {},
  stmts: { getAgentSkillOverrides: { all: () => [] } },
}));

vi.mock('../wiki.js', () => ({
  getWikiContext: () => '',
}));

vi.mock('../routes/skills.js', () => ({
  collectSkillsFromDir: () => [],
  DEFAULT_SKILLS_DIR: '/tmp/no-skills',
}));

vi.mock('../config.js', () => ({
  default: { defaultModel: 'claude-sonnet-4-20250514' },
  defaultModelForEngine: () => 'claude-sonnet-4-20250514',
  buildSpawnEnv: () => ({}),
}));

const tmpBase = path.join(os.tmpdir(), `finalize-prompt-test-${Date.now()}`);

vi.mock('../project-paths.js', () => ({
  resolveProjectPaths: () => ({ skillsDir: path.join(tmpBase, 'skills'), contextFiles: {} }),
  contextFilePath: (_paths: unknown, filename: string) => {
    const p = path.join(tmpBase, filename);
    return existsSync(p) ? p : null;
  },
}));

const mockFindProject = vi.hoisted(() =>
  vi.fn((_id: string): import('../types.js').Project | null => null),
);

vi.mock('../project-model.js', () => ({
  allAgents: () => [],
  findProject: (id: string) => mockFindProject(id),
}));

import { buildEnrichedPrompt } from '../chat.js';
import { DEFAULT_CI_CONFIG_RELATIVE_PATH } from './finalize-keys.js';

function makeProject(overrides: Record<string, unknown> = {}) {
  return {
    id: 'proj-1',
    cwd: tmpBase,
    ahw: tmpBase,
    githubRepo: 'owner/repo',
    ...overrides,
  };
}

function makeAgent() {
  return {
    id: 'agent-1',
    name: 'Test Agent',
    cwd: tmpBase,
    workspace: tmpBase,
    systemPrompt: '',
  };
}

describe('buildEnrichedPrompt — Finalize configured', () => {
  beforeEach(() => {
    mockFindProject.mockReset();
    mockFindProject.mockImplementation(() => null);
    mkdirSync(path.join(tmpBase, 'skills'), { recursive: true });
    mkdirSync(path.join(tmpBase, '.agent-hub'), { recursive: true });
    writeFileSync(path.join(tmpBase, DEFAULT_CI_CONFIG_RELATIVE_PATH), 'steps: []\n');
  });

  afterEach(() => {
    rmSync(tmpBase, { recursive: true, force: true });
  });

  it('suppresses direct ship instructions when finalizeConfigured is true', () => {
    const prompt = buildEnrichedPrompt(makeProject() as never, makeAgent() as never, {
      isFirstMessage: true,
      finalizeConfigured: true,
    });
    expect(prompt).toContain('Finalize Code Changes — No Direct Ship');
    expect(prompt).toContain('must not run `git push` or `gh pr create`');
    expect(prompt).toContain("Bias to Action — Don't Ask, Just Build");
    expect(prompt).not.toMatch(/commit, push, and open the PR/i);
    expect(prompt).not.toMatch(/open the PR with `gh pr create`/i);
  });

  it('discourages full ci.yaml runs in-session when finalizeConfigured', () => {
    const prompt = buildEnrichedPrompt(makeProject() as never, makeAgent() as never, {
      isFirstMessage: true,
      finalizeConfigured: true,
    });
    expect(prompt).toContain('Do not run the full `.agent-hub/ci.yaml` suite in-session');
    expect(prompt).toContain('targeted');
  });

  it('warns agents to commit in the session worktree, not project cwd', () => {
    const wt = path.join(tmpBase, 'session-wt');
    mkdirSync(wt, { recursive: true });
    const prompt = buildEnrichedPrompt(makeProject() as never, makeAgent() as never, {
      isFirstMessage: true,
      finalizeConfigured: true,
      useWorktree: true,
      sessionWorktreePath: wt,
      sessionWorktreeBranch: 'agent-hub/scorecard-dev/session-abc',
    });
    expect(prompt).toContain('Session worktree only');
    expect(prompt).toContain(wt);
    expect(prompt).toContain('agent-hub/scorecard-dev/session-abc');
    expect(prompt).toContain('different');
    expect(prompt).toContain(tmpBase);
  });

  it('still includes ship instructions when finalizeConfigured is false', () => {
    const prompt = buildEnrichedPrompt(makeProject() as never, makeAgent() as never, {
      isFirstMessage: true,
      finalizeConfigured: false,
    });
    expect(prompt).toContain("Bias to Action — Don't Ask, Just Ship");
    expect(prompt).toMatch(/open the PR with `gh pr create`/i);
  });
});
