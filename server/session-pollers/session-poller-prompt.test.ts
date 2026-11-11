/**
 * The poller block must be advertised on every turn: "every 30 min check X"
 * can arrive mid-session, and a capability missing from the follow-up prompt
 * is one the agent won't use.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync } from 'fs';
import path from 'path';
import os from 'os';

const tmpBase = path.join(os.tmpdir(), `session-poller-prompt-${Date.now()}`);

vi.mock('../db.js', () => ({
  db: {},
  stmts: {
    getAgentSkillOverrides: { all: () => [] },
  },
}));

vi.mock('../wiki.js', () => ({
  getWikiContext: () => '',
}));

vi.mock('../routes/skills.js', () => ({
  collectSkillsFromDir: () => [],
  DEFAULT_SKILLS_DIR: '/tmp/no-default-skills',
}));

vi.mock('../config.js', () => ({
  default: { defaultModel: 'claude-sonnet-4-20250514' },
  defaultModelForEngine: () => 'claude-sonnet-4-20250514',
  buildSpawnEnv: () => ({}),
}));

vi.mock('../project-paths.js', () => ({
  resolveProjectPaths: () => ({
    skillsDir: path.join(tmpBase, 'project-skills'),
    contextFiles: {},
  }),
  contextFilePath: () => null,
}));

vi.mock('../project-model.js', () => ({
  allAgents: () => [],
  findProject: () => null,
}));

import { buildEnrichedPrompt } from '../chat.js';

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

describe('buildEnrichedPrompt — session poller guidance', () => {
  beforeEach(() => mkdirSync(tmpBase, { recursive: true }));
  afterEach(() => rmSync(tmpBase, { recursive: true, force: true }));

  it.each([true, false])('advertises the agenthub:poller block (isFirstMessage=%s)', (first) => {
    const prompt = buildEnrichedPrompt(makeProject(), makeAgent(), { isFirstMessage: first });
    expect(prompt).toContain('## Session Pollers (recurring checks)');
    expect(prompt).toContain('```agenthub:poller');
    expect(prompt).toContain('"intervalMinutes"');
    // End times stay in the user's words so the card can resolve them locally.
    expect(prompt).toContain('"until":"tomorrow 09:00"');
  });

  it('steers chat schedules away from native schedulers and project crons', () => {
    const prompt = buildEnrichedPrompt(makeProject(), makeAgent(), { isFirstMessage: false });
    expect(prompt).toContain('CronCreate');
    expect(prompt).toContain('agent-hub-heartbeats-crons');
    expect(prompt).toContain('is a poller even when each run should open forward sessions');
  });
});
