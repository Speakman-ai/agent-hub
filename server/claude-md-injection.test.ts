/**
 * CLAUDE.md lives in the git checkout (cwd / session worktree), not in the
 * Hub workspace (`ahw` = ~/.agent-hub/projects/<id>/). After ahw was
 * relocated off the repo checkout, buildEnrichedPrompt kept reading
 * ahw/CLAUDE.md — a file that is never seeded — so engines that do not
 * native-load CLAUDE.md (Cursor / Gemini / Grok) got none.
 *
 * These tests use the real contextFilePath (not the tmpBase-flattening
 * mock other prompt suites install) so a regression that joins ahw again
 * fails.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'fs';
import path from 'path';
import os from 'os';

vi.mock('./db.js', () => ({
  db: {},
  stmts: { getAgentSkillOverrides: { all: () => [] } },
}));
vi.mock('./wiki.js', () => ({
  getWikiContext: () => '',
}));
vi.mock('./routes/skills.js', () => ({
  collectSkillsFromDir: () => [],
  DEFAULT_SKILLS_DIR: '/tmp/no-skills',
}));
vi.mock('./config.js', () => ({
  default: { defaultModel: 'claude-sonnet-4-20250514', dataDir: '/tmp' },
  defaultModelForEngine: () => 'claude-sonnet-4-20250514',
  buildSpawnEnv: () => ({}),
}));
vi.mock('./project-model.js', () => ({
  allAgents: () => [],
  findProject: () => null,
}));

import { buildEnrichedPrompt } from './chat.js';

const tmpRoot = path.join(os.tmpdir(), `claude-md-inject-${Date.now()}`);
const ahwDir = path.join(tmpRoot, 'ahw');
const cwdDir = path.join(tmpRoot, 'cwd');
const worktreeDir = path.join(tmpRoot, 'worktree');

function makeProject() {
  return {
    id: 'claude-md-proj',
    name: 'CLAUDE.md Project',
    cwd: cwdDir,
    ahw: ahwDir,
    agents: [],
  };
}

function makeAgent() {
  return {
    id: 'claude-md-agent',
    name: 'CLAUDE.md Agent',
    engine: 'cursor-agent',
    systemPrompt: 'You are a test agent.',
    role: 'member' as const,
  };
}

describe('CLAUDE.md injection from checkout, not ahw', () => {
  beforeEach(() => {
    mkdirSync(ahwDir, { recursive: true });
    mkdirSync(cwdDir, { recursive: true });
    mkdirSync(worktreeDir, { recursive: true });
    writeFileSync(path.join(ahwDir, 'CLAUDE.md'), 'AHW-DECOY-SHOULD-NOT-INJECT');
    writeFileSync(path.join(cwdDir, 'CLAUDE.md'), 'CHECKOUT-CLAUDE-MD-BODY');
    writeFileSync(path.join(worktreeDir, 'CLAUDE.md'), 'WORKTREE-CLAUDE-MD-BODY');
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('injects CLAUDE.md from cwd on the first turn, ignoring a decoy in ahw', () => {
    const first = buildEnrichedPrompt(makeProject(), makeAgent(), { isFirstMessage: true });
    expect(first).toContain('## CLAUDE.md');
    expect(first).toContain('CHECKOUT-CLAUDE-MD-BODY');
    expect(first).not.toContain('AHW-DECOY-SHOULD-NOT-INJECT');
  });

  it('omits CLAUDE.md on follow-up turns', () => {
    const subsequent = buildEnrichedPrompt(makeProject(), makeAgent(), {
      isFirstMessage: false,
    });
    expect(subsequent).not.toContain('## CLAUDE.md');
    expect(subsequent).not.toContain('CHECKOUT-CLAUDE-MD-BODY');
  });

  it('prefers the session worktree over project.cwd when both have CLAUDE.md', () => {
    const first = buildEnrichedPrompt(makeProject(), makeAgent(), {
      isFirstMessage: true,
      sessionWorktreePath: worktreeDir,
    });
    expect(first).toContain('WORKTREE-CLAUDE-MD-BODY');
    expect(first).not.toContain('CHECKOUT-CLAUDE-MD-BODY');
    expect(first).not.toContain('AHW-DECOY-SHOULD-NOT-INJECT');
  });

  it('injects nothing when CLAUDE.md exists only under ahw', () => {
    rmSync(path.join(cwdDir, 'CLAUDE.md'));
    const first = buildEnrichedPrompt(makeProject(), makeAgent(), { isFirstMessage: true });
    expect(first).not.toContain('## CLAUDE.md');
    expect(first).not.toContain('AHW-DECOY-SHOULD-NOT-INJECT');
  });
});
