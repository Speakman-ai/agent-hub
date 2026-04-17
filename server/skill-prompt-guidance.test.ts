/**
 * Tests for the `## Available Skills` section of the enriched prompt.
 *
 * Regression coverage for bug: "Skills are not callable it seems".
 * When the user asks for a capability backed by a service name (e.g. "linear"),
 * agents have invoked `Skill({ skill: "linear" })` and received
 * `<tool_use_error>Unknown skill: linear</tool_use_error>` from the Claude
 * Code CLI because the skill simply does not exist.
 *
 * The fix adds explicit guidance to the prompt: (1) how to invoke a skill,
 * (2) that only the listed skills are registered, and (3) what to do when the
 * user's request does not correspond to any listed skill.
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

  it('tells the agent how to invoke a skill via the Skill tool', () => {
    mockSkills.push({
      id: 'kanban',
      name: 'kanban',
      description: 'Manage the board.',
      path: '/p/kanban',
    });
    const prompt = buildEnrichedPrompt(makeProject(), makeAgent(), { isFirstMessage: true });
    expect(prompt).toMatch(/Skill\(\{\s*skill:\s*"kanban"\s*\}\)/);
    expect(prompt).toMatch(/`Skill`\s+tool/);
  });

  it('warns that only listed skills are callable (Unknown skill failure mode)', () => {
    mockSkills.push({
      id: 'kanban',
      name: 'kanban',
      description: 'Manage the board.',
      path: '/p/kanban',
    });
    const prompt = buildEnrichedPrompt(makeProject(), makeAgent(), { isFirstMessage: true });
    // Must reference the exact error string so the agent learns the failure mode
    expect(prompt).toContain('Unknown skill');
    // Must make clear the list is exhaustive
    expect(prompt.toLowerCase()).toMatch(/only.*skills/);
  });

  it('tells the agent to fall back to Bash/WebFetch for unlisted capabilities', () => {
    mockSkills.push({
      id: 'kanban',
      name: 'kanban',
      description: 'Manage the board.',
      path: '/p/kanban',
    });
    const prompt = buildEnrichedPrompt(makeProject(), makeAgent(), { isFirstMessage: true });
    expect(prompt).toMatch(/Bash|WebFetch/);
  });

  it('regression: does not suggest a hallucinated service name like "linear" is a skill', () => {
    // With only kanban registered, the example invocation must use a real name
    mockSkills.push({
      id: 'kanban',
      name: 'kanban',
      description: 'Manage the board.',
      path: '/p/kanban',
    });
    const prompt = buildEnrichedPrompt(makeProject(), makeAgent(), { isFirstMessage: true });
    // The section should not teach the agent that "linear" is invocable
    expect(prompt).not.toMatch(/Skill\(\{\s*skill:\s*"linear"\s*\}\)/);
    // The example in the invocation guidance must use the first registered skill
    expect(prompt).toMatch(/Skill\(\{\s*skill:\s*"kanban"\s*\}\)/);
  });

  it('uses the first registered skill as the invocation example', () => {
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
    expect(prompt).toMatch(/Skill\(\{\s*skill:\s*"using-git-worktrees"\s*\}\)/);
  });
});
