/**
 * Tests for the `## Long-Running Commands — Start Them as Hub-Owned Background
 * Shells` section of the enriched prompt.
 *
 * Regression coverage for bug: "Background processes get killed". The
 * Hub-owned background-shell runtime (`background-shells/`, the REST surface,
 * the `bg.sh` wrapper, the Background shells panel) shipped fully wired, but
 * nothing in the agent-facing prompt said it existed. Agents kept starting
 * multi-minute test runs with the CLI's native `run_in_background` Bash — a
 * grandchild of the per-turn CLI process — watched them die at turn end, and
 * then burned turns on `nohup` / `setsid` / detach-inside-docker workarounds
 * that don't survive an interrupt either.
 *
 * The fix injects first-message guidance into `buildEnrichedPrompt` naming
 * `bg.sh` as the surface for work that must outlive the turn.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync } from 'fs';
import path from 'path';
import os from 'os';

const tmpBase = path.join(os.tmpdir(), `bg-shell-prompt-${Date.now()}`);

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
  findProject: () => null,
}));

import { buildEnrichedPrompt } from './chat.js';

const SECTION = '## Long-Running Commands — Start Them as Hub-Owned Background Shells';

function makeProject(overrides = {}) {
  return {
    id: 'test-proj',
    name: 'Test Project',
    cwd: tmpBase,
    ahw: tmpBase,
    agents: [],
    ...overrides,
  };
}

function makeAgent(overrides = {}) {
  return {
    id: 'test-agent',
    name: 'Test Agent',
    engine: 'claude-code',
    systemPrompt: 'You are a test agent.',
    role: 'member' as const,
    ...overrides,
  };
}

describe('buildEnrichedPrompt — background-shell guidance', () => {
  beforeEach(() => {
    mkdirSync(tmpBase, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpBase, { recursive: true, force: true });
  });

  it('documents the background-shell section on the first message', () => {
    const prompt = buildEnrichedPrompt(makeProject(), makeAgent(), { isFirstMessage: true });
    expect(prompt).toContain(SECTION);
  });

  it('states that the native run_in_background shell cannot outlive the turn', () => {
    const prompt = buildEnrichedPrompt(makeProject(), makeAgent(), { isFirstMessage: true });
    expect(prompt).toContain('`run_in_background`');
    expect(prompt).toContain('cannot outlive this turn');
  });

  it('names Stop / interrupt as a kill path, not just turn end', () => {
    // The reported session died on a user interrupt mid-run, so the guidance
    // must not imply "it only dies when the turn completes normally".
    const prompt = buildEnrichedPrompt(makeProject(), makeAgent(), { isFirstMessage: true });
    expect(prompt).toContain('SIGTERMs the whole process group');
  });

  it('rules out the nohup / setsid / detach-in-container workarounds', () => {
    const prompt = buildEnrichedPrompt(makeProject(), makeAgent(), { isFirstMessage: true });
    expect(prompt).toContain('`nohup`');
    expect(prompt).toContain('`setsid`');
    expect(prompt).toContain('not** reliable workarounds');
  });

  it('names bg.sh and its subcommands so the agent can drive it without loading a skill', () => {
    const prompt = buildEnrichedPrompt(makeProject(), makeAgent(), { isFirstMessage: true });
    for (const cmd of ['bg.sh start', 'bg.sh list', 'bg.sh status', 'bg.sh logs', 'bg.sh stop']) {
      expect(prompt).toContain(cmd);
    }
  });

  it('documents the status vocabulary and session-scoped reaping', () => {
    const prompt = buildEnrichedPrompt(makeProject(), makeAgent(), { isFirstMessage: true });
    expect(prompt).toContain('Background shells panel');
    expect(prompt).toContain('`running`');
    expect(prompt).toContain('`exited`');
    expect(prompt).toContain('`failed`');
    expect(prompt).toContain('`stopped`');
    expect(prompt).toContain('archived or deleted');
  });

  it('omits the section on follow-up (non-first) messages', () => {
    const prompt = buildEnrichedPrompt(makeProject(), makeAgent(), { isFirstMessage: false });
    expect(prompt).not.toContain(SECTION);
  });
});
