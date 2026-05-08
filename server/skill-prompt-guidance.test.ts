/**
 * Tests for the `## Available Skills` section of the enriched prompt.
 *
 * Regression coverage for bug: "Skills are not callable it seems".
 * When the user asks for a capability backed by a service name (e.g. "linear"),
 * agents have invoked `Skill({ skill: "linear" })` and received
 * `<tool_use_error>Unknown skill: linear</tool_use_error>` from the Claude
 * Code CLI because the skill simply does not exist.
 *
 * The gateway fix adds explicit guidance to the prompt: emit
 * `<agenthub:skill>` for next-turn loading and keep the list of
 * available skill IDs/descriptions.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync } from 'fs';
import path from 'path';
import os from 'os';

const tmpBase = path.join(os.tmpdir(), `skill-prompt-guidance-${Date.now()}`);

// Mock db
vi.mock('./db.js', () => ({
  stmts: {
    getAgentSkillOverrides: { all: () => [] },
  },
}));

// Mock wiki
vi.mock('./wiki.js', () => ({
  getWikiContext: () => '',
}));

// Use a mutable skill list so individual tests can control what skills exist
const mockSkills: Array<{ id: string; name: string; description: string; path: string }> = [];

vi.mock('./routes/skills.js', () => ({
  collectSkillsFromDir: (dir: string) => {
    // Only return skills for the project skills dir (first call); default dir returns [].
    if (dir.includes('project-skills')) return mockSkills;
    return [];
  },
  DEFAULT_SKILLS_DIR: '/tmp/no-default-skills',
}));

// Mock config
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

const mockFindProject = vi.hoisted(() =>
  vi.fn((_id: string): import('./types.js').Project | null => null),
);

vi.mock('./project-model.js', () => ({
  allAgents: () => [],
  findProject: (id: string) => mockFindProject(id),
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

describe('buildEnrichedPrompt — Available Skills guidance', () => {
  beforeEach(() => {
    mkdirSync(tmpBase, { recursive: true });
    mockSkills.length = 0;
    mockFindProject.mockReset();
    mockFindProject.mockImplementation(() => null);
  });

  afterEach(() => {
    rmSync(tmpBase, { recursive: true, force: true });
  });

  it('omits the Available Skills section entirely when no skills are registered', () => {
    const prompt = buildEnrichedPrompt(makeProject(), makeAgent(), {
      isFirstMessage: true,
    });
    expect(prompt).not.toContain('## Available Skills');
  });

  it('lists each registered skill by its exact invocable name', () => {
    mockSkills.push(
      { id: 'kanban', name: 'kanban', description: 'Manage the board.', path: '/p/kanban' },
      { id: 'wiki-search', name: 'wiki-search', description: 'Query the wiki.', path: '/p/wiki' },
    );
    const prompt = buildEnrichedPrompt(makeProject(), makeAgent(), { isFirstMessage: true });
    expect(prompt).toContain('## Available Skills');
    expect(prompt).toContain('- **kanban**: Manage the board.');
    expect(prompt).toContain('- **wiki-search**: Query the wiki.');
  });

  it('tells the agent to invoke skills via <agenthub:skill> block protocol', () => {
    mockSkills.push({
      id: 'kanban',
      name: 'kanban',
      description: 'Manage the board.',
      path: '/p/kanban',
    });
    const prompt = buildEnrichedPrompt(makeProject(), makeAgent(), { isFirstMessage: true });
    expect(prompt).toContain('<agenthub:skill>');
    expect(prompt).toContain('{"name": "<skill-id>", "reason": "<one-liner why>"}');
  });

  it('states this replaces the native Skill tool across engines', () => {
    mockSkills.push({
      id: 'kanban',
      name: 'kanban',
      description: 'Manage the board.',
      path: '/p/kanban',
    });
    const prompt = buildEnrichedPrompt(makeProject(), makeAgent(), { isFirstMessage: true });
    expect(prompt).toContain('replaces the native `Skill` tool');
    expect(prompt).toContain('claude-code, cursor-agent, and codex');
  });

  it('warns that only listed skills are loadable and mentions Unknown skill + Bash/WebFetch fallback', () => {
    mockSkills.push({
      id: 'kanban',
      name: 'kanban',
      description: 'Manage the board.',
      path: '/p/kanban',
    });
    const prompt = buildEnrichedPrompt(makeProject(), makeAgent(), { isFirstMessage: true });
    expect(prompt).toContain('Unknown skill');
    expect(prompt.toLowerCase()).toMatch(/only the skills listed below/);
    expect(prompt).toMatch(/Bash.*WebFetch|WebFetch.*Bash/);
  });

  it('does not mention direct Skill() tool invocation', () => {
    mockSkills.push({
      id: 'kanban',
      name: 'kanban',
      description: 'Manage the board.',
      path: '/p/kanban',
    });
    const prompt = buildEnrichedPrompt(makeProject(), makeAgent(), { isFirstMessage: true });
    expect(prompt).not.toMatch(/Skill\(\{/);
  });

  it('regression: does not suggest a hallucinated service name like "linear" is a skill', () => {
    // With only kanban registered, guidance must not suggest native invocation.
    mockSkills.push({
      id: 'kanban',
      name: 'kanban',
      description: 'Manage the board.',
      path: '/p/kanban',
    });
    const prompt = buildEnrichedPrompt(makeProject(), makeAgent(), { isFirstMessage: true });
    expect(prompt).not.toMatch(/Skill\(\{\s*skill:\s*"linear"\s*\}\)/);
    expect(prompt).toContain('<agenthub:skill>');
  });

  it('always includes the listed skills with names/descriptions', () => {
    mockSkills.push(
      {
        id: 'using-git-worktrees',
        name: 'using-git-worktrees',
        description: 'Worktrees.',
        path: '/p/wt',
      },
      { id: 'kanban', name: 'kanban', description: 'Board.', path: '/p/kanban' },
    );
    const prompt = buildEnrichedPrompt(makeProject(), makeAgent(), { isFirstMessage: true });
    expect(prompt).toContain('- **using-git-worktrees**: Worktrees.');
    expect(prompt).toContain('- **kanban**: Board.');
  });
});
