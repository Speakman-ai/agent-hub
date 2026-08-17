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

  it('makes the credential-request block the path for interactive secrets and bans external secret managers', () => {
    const prompt = buildEnrichedPrompt(makeProject(), makeAgent(), { isFirstMessage: true });
    // Regression for the Survey Tracker "log me in" session: the agent claimed
    // there was no secure prompt and steered the user to 1Password / paste-in-chat
    // instead of emitting the masked credential-request card.
    expect(prompt).toContain('collecting a username/password or any one-off secret');
    expect(prompt).toContain('1Password');
    expect(prompt).toContain('`op` CLI');
    // The picker is barred for the secret itself (it renders plaintext) but
    // allowed for the non-secret environment choice — keep both halves stated.
    expect(prompt).toContain('Never route the secret itself through the `agenthub:ask` picker');
    expect(prompt).toContain('renders in plaintext');
  });

  it('scopes the rule to interactive secrets and preserves the persistent skill-credential store', () => {
    const prompt = buildEnrichedPrompt(makeProject(), makeAgent(), { isFirstMessage: true });
    // Regression for reviewer feedback: the guidance must not claim the session
    // block is the ONLY path for "any secret" — reusable integration tokens
    // (a skill's `credentials:` block, e.g. a GitHub PAT) belong in the
    // persistent Settings → My Skill Credentials store, not a one-time request.
    expect(prompt).toContain('Reusable integration tokens are the exception');
    expect(prompt).toContain('`credentials:` frontmatter');
    expect(prompt).toContain('Settings → My Skill Credentials');
    expect(prompt).toContain('injects it into your environment');
  });

  it('documents the consume retrieval path via the session API', () => {
    const prompt = buildEnrichedPrompt(makeProject(), makeAgent(), { isFirstMessage: true });
    expect(prompt).toContain('/credential-requests/<requestId>/consume');
  });

  it('tells the agent to re-consume the same requestId instead of asking the user to resubmit', () => {
    const prompt = buildEnrichedPrompt(makeProject(), makeAgent(), { isFirstMessage: true });
    // Regression for "Had to be asked multiple times for credentials": an agent
    // that burns the read in a throwaway probe must recover by re-consuming,
    // not by re-prompting the user for their password.
    expect(prompt).toContain('stays retrievable until');
    expect(prompt).toContain('instead of asking the user to resubmit');
  });

  it('omits the section on follow-up (non-first) messages', () => {
    const prompt = buildEnrichedPrompt(makeProject(), makeAgent(), { isFirstMessage: false });
    expect(prompt).not.toContain('## Requesting Secrets & Credentials Securely');
  });
});
