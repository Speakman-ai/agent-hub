/**
 * Tests for the `## Requesting Secrets & Credentials Securely` section of the
 * enriched prompt.
 *
 * Regression coverage for bug: "Credential session box not showing". The
 * session-scoped credential-request feature (secure masked input card, REST
 * storage, consume-once API) shipped fully wired on the client/mobile/server,
 * but nothing ever told the agent it existed. Agents therefore asked users for
 * usernames/passwords in plain chat prose, so the secure box never rendered.
 *
 * The fix injects guidance into `buildEnrichedPrompt` on the first message:
 * emit a fenced `agenthub:credential-request` block instead of asking for a
 * secret in prose, then consume the value once via the session API.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync } from 'fs';
import path from 'path';
import os from 'os';

const tmpBase = path.join(os.tmpdir(), `credential-request-prompt-${Date.now()}`);

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

describe('buildEnrichedPrompt — credential-request guidance', () => {
  beforeEach(() => {
    mkdirSync(tmpBase, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpBase, { recursive: true, force: true });
  });

  it('documents the secure credential-request section on the first message', () => {
    const prompt = buildEnrichedPrompt(makeProject(), makeAgent(), { isFirstMessage: true });
    expect(prompt).toContain('## Requesting Secrets & Credentials Securely');
  });

  it('tells the agent to emit a fenced agenthub:credential-request block', () => {
    const prompt = buildEnrichedPrompt(makeProject(), makeAgent(), { isFirstMessage: true });
    expect(prompt).toContain('```agenthub:credential-request');
    // the example envelope shape must be present so the model has a template
    expect(prompt).toContain('"requestId"');
    expect(prompt).toContain('"fields"');
    expect(prompt).toContain('"type": "password"');
  });

  it('forbids asking for secrets in plain chat prose', () => {
    const prompt = buildEnrichedPrompt(makeProject(), makeAgent(), { isFirstMessage: true });
    expect(prompt.toLowerCase()).toContain('never ask for it in plain prose');
  });

  it('documents the consume-once retrieval path via the session API', () => {
    const prompt = buildEnrichedPrompt(makeProject(), makeAgent(), { isFirstMessage: true });
    expect(prompt).toContain('/credential-requests/<requestId>/consume');
  });

  it('omits the section on follow-up (non-first) messages', () => {
    const prompt = buildEnrichedPrompt(makeProject(), makeAgent(), { isFirstMessage: false });
    expect(prompt).not.toContain('## Requesting Secrets & Credentials Securely');
  });
});
