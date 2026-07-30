/**
 * Project agent roster — injected into enriched system prompts so every agent
 * sees other agents on the same project (id, name, role) on every turn.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, existsSync } from 'fs';
import path from 'path';
import os from 'os';
import type { EnrichedAgent } from './types.js';

const tmpBase = path.join(os.tmpdir(), `agent-roster-test-${Date.now()}`);

const { mockAllAgents, mockFindProject } = vi.hoisted(() => ({
  mockAllAgents: vi.fn((): EnrichedAgent[] => []),
  mockFindProject: vi.fn((_id: string): import('./types.js').Project | null => null),
}));

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
  DEFAULT_SKILLS_DIR: '/tmp/no-skills',
}));

vi.mock('./config.js', () => ({
  default: { defaultModel: 'claude-sonnet-4-20250514' },
  defaultModelForEngine: () => 'claude-sonnet-4-20250514',
  buildSpawnEnv: () => ({}),
}));

vi.mock('./project-paths.js', () => ({
  resolveProjectPaths: () => ({
    skillsDir: path.join(tmpBase, 'skills'),
    contextFiles: {},
  }),
  contextFilePath: (_paths: unknown, filename: string) => {
    const p = path.join(tmpBase, filename);
    return existsSync(p) ? p : null;
  },
}));

vi.mock('./project-model.js', () => ({
  allAgents: () => mockAllAgents(),
  findProject: (id: string) => mockFindProject(id),
}));

import { buildEnrichedPrompt, formatProjectAgentRosterSection } from './chat.js';

function makeProject(overrides: Record<string, unknown> = {}) {
  return {
    id: 'proj-a',
    name: 'Project A',
    cwd: tmpBase,
    ahw: tmpBase,
    agents: [],
    ...overrides,
  };
}

function makeAgent(overrides: Record<string, unknown> = {}) {
  return {
    id: 'alice',
    name: 'Alice',
    engine: 'claude-code',
    systemPrompt: 'You are Alice.',
    role: 'sub',
    ...overrides,
  };
}

function enriched(overrides: Partial<EnrichedAgent>): EnrichedAgent {
  const base: EnrichedAgent = {
    id: 'x',
    name: 'X',
    engine: 'claude-code',
    projectId: 'proj-a',
    projectName: 'Project A',
    cwd: tmpBase,
    ahw: tmpBase,
    workspace: tmpBase,
  };
  return { ...base, ...overrides };
}

describe('formatProjectAgentRosterSection', () => {
  it('returns empty string when there are no peers', () => {
    expect(formatProjectAgentRosterSection([])).toBe('');
  });

  it('lists id, display name, and role when present', () => {
    const s = formatProjectAgentRosterSection([
      { id: 'lead-1', name: 'Lead Bot', role: 'lead' },
      { id: 'sub-2', name: 'Sub Bot', role: 'sub' },
    ]);
    expect(s).toContain('## Project agent roster');
    expect(s).toContain('**Lead Bot** (`lead-1`) · Role: lead');
    expect(s).toContain('**Sub Bot** (`sub-2`) · Role: sub');
  });

  it('omits role line when role is absent', () => {
    const s = formatProjectAgentRosterSection([{ id: 'only-id', name: 'Pat' }]);
    expect(s).toContain('**Pat** (`only-id`)');
    expect(s).not.toMatch(/Pat.*Role:/);
  });
});

describe('buildEnrichedPrompt — project agent roster', () => {
  beforeEach(() => {
    mkdirSync(tmpBase, { recursive: true });
    mockAllAgents.mockReset();
    mockFindProject.mockReset();
    mockFindProject.mockImplementation(() => null);
  });

  afterEach(() => {
    rmSync(tmpBase, { recursive: true, force: true });
  });

  it('injects peers on the same project and excludes self and other projects', () => {
    mockAllAgents.mockReturnValue([
      enriched({ id: 'alice', name: 'Alice', role: 'sub', systemPrompt: 'You are Alice.' }),
      enriched({ id: 'bob', name: 'Bob', role: 'lead', systemPrompt: 'Bob prompt' }),
      enriched({
        id: 'remote',
        name: 'Remote',
        role: 'sub',
        projectId: 'other-proj',
        projectName: 'Other',
        systemPrompt: 'x',
      }),
    ]);

    const prompt = buildEnrichedPrompt(
      makeProject({ id: 'proj-a' }),
      makeAgent({ id: 'alice', name: 'Alice' }),
      {
        isFirstMessage: false,
      },
    );

    expect(prompt).toContain('## Project agent roster');
    expect(prompt).toContain('**Bob** (`bob`) · Role: lead');
    expect(prompt).not.toContain('remote');
    expect(prompt).not.toContain('**Alice** (`alice`)');
  });

  it('omits the roster section when the agent has no project id', () => {
    mockAllAgents.mockReturnValue([
      enriched({ id: 'orphan', name: 'Orphan', projectId: 'proj-a', systemPrompt: 'x' }),
    ]);

    const prompt = buildEnrichedPrompt(
      { cwd: tmpBase, ahw: tmpBase } as import('./types.js').Project,
      makeAgent({ id: 'orphan', name: 'Orphan' }) as import('./types.js').Agent,
      {},
    );

    expect(prompt).not.toContain('## Project agent roster');
  });

  it('includes roster when called with a single EnrichedAgent argument', () => {
    mockAllAgents.mockReturnValue([
      enriched({ id: 'me', name: 'Me', systemPrompt: 'body', role: 'sub' }),
      enriched({ id: 'peer', name: 'Peer', systemPrompt: 'p', role: 'lead' }),
    ]);

    const agentOnly = enriched({ id: 'me', name: 'Me', systemPrompt: 'body', role: 'sub' });
    const prompt = buildEnrichedPrompt(agentOnly);

    expect(prompt).toContain('## Project agent roster');
    expect(prompt).toContain('**Peer** (`peer`)');
  });
});
