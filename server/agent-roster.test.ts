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

const { mockAllAgents } = vi.hoisted(() => ({
  mockAllAgents: vi.fn((): EnrichedAgent[] => []),
}));

vi.mock('./db.js', () => ({
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

  it('omits the delegate-allowlist annotation when no allowlist is provided', () => {
    const s = formatProjectAgentRosterSection([
      { id: 'lead-1', name: 'Lead Bot', role: 'lead' },
      { id: 'sub-2', name: 'Sub Bot', role: 'sub' },
    ]);
    expect(s).not.toContain('Valid `<delegate>` targets');
  });

  it('omits the delegate-allowlist annotation for an empty allowlist', () => {
    const s = formatProjectAgentRosterSection(
      [
        { id: 'lead-1', name: 'Lead Bot', role: 'lead' },
        { id: 'sub-2', name: 'Sub Bot', role: 'sub' },
      ],
      [],
    );
    expect(s).not.toContain('Valid `<delegate>` targets');
  });

  it('lists only allowlisted peers as valid <delegate> targets', () => {
    const s = formatProjectAgentRosterSection(
      [
        { id: 'sub-frontend', name: 'Frontend', role: 'sub' },
        { id: 'sub-backend', name: 'Backend', role: 'sub' },
        { id: 'reviewer', name: 'Reviewer', role: 'reviewer' },
      ],
      ['sub-frontend', 'sub-backend'],
    );
    expect(s).toContain('### Valid `<delegate>` targets');
    expect(s).toContain('**Frontend** (`sub-frontend`)');
    expect(s).toContain('**Backend** (`sub-backend`)');
    // Reviewer is a peer but NOT a delegate target — must be present in the
    // top section but absent from the "Valid delegate targets" list.
    const delegateSection = s.slice(s.indexOf('### Valid `<delegate>` targets'));
    expect(delegateSection).not.toContain('**Reviewer**');
    // And the handoff/chat-only note should appear since there are non-allowlisted peers.
    expect(s).toContain('reachable via `<handoff>`');
    expect(s).toContain('silently dropped by the server');
  });

  it('flags allowlist entries that do not match any peer on the project', () => {
    const s = formatProjectAgentRosterSection(
      [{ id: 'sub-frontend', name: 'Frontend', role: 'sub' }],
      ['sub-frontend', 'ghost-agent'],
    );
    expect(s).toContain('Configured but not on this project');
    expect(s).toContain('`ghost-agent`');
    expect(s).not.toContain('`sub-frontend`,'); // non-orphan should not be in the orphan note
  });

  it('warns when the allowlist matches no peer at all', () => {
    const s = formatProjectAgentRosterSection(
      [{ id: 'peer-only', name: 'Peer', role: 'sub' }],
      ['nobody', 'still-nobody'],
    );
    expect(s).toContain('### Valid `<delegate>` targets');
    expect(s).toContain('None of your configured sub-agents');
    expect(s).toContain('`nobody`');
    expect(s).toContain('`still-nobody`');
  });

  it('omits the handoff fallback note when every peer is on the allowlist', () => {
    const s = formatProjectAgentRosterSection(
      [
        { id: 'sub-a', name: 'A', role: 'sub' },
        { id: 'sub-b', name: 'B', role: 'sub' },
      ],
      ['sub-a', 'sub-b'],
    );
    expect(s).toContain('### Valid `<delegate>` targets');
    expect(s).not.toContain('reachable via `<handoff>`');
  });
});

describe('buildEnrichedPrompt — project agent roster', () => {
  beforeEach(() => {
    mkdirSync(tmpBase, { recursive: true });
    mockAllAgents.mockReset();
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

  it("propagates the lead's subAgents allowlist into the roster section", () => {
    mockAllAgents.mockReturnValue([
      enriched({ id: 'lead', name: 'Lead', role: 'lead' }),
      enriched({ id: 'frontend', name: 'Frontend', role: 'sub' }),
      enriched({ id: 'backend', name: 'Backend', role: 'sub' }),
      enriched({ id: 'reviewer', name: 'Reviewer', role: 'reviewer' }),
    ]);

    const prompt = buildEnrichedPrompt(
      makeProject({ id: 'proj-a' }),
      makeAgent({
        id: 'lead',
        name: 'Lead',
        role: 'lead',
        subAgents: ['frontend', 'backend'],
      }),
    );

    expect(prompt).toContain('### Valid `<delegate>` targets');
    expect(prompt).toContain('**Frontend** (`frontend`)');
    expect(prompt).toContain('**Backend** (`backend`)');
    const delegateSection = prompt.slice(prompt.indexOf('### Valid `<delegate>` targets'));
    expect(delegateSection).not.toContain('**Reviewer**');
  });

  it('omits the delegate-allowlist annotation for agents without subAgents', () => {
    mockAllAgents.mockReturnValue([
      enriched({ id: 'sub', name: 'Sub', role: 'sub' }),
      enriched({ id: 'peer', name: 'Peer', role: 'sub' }),
    ]);

    const prompt = buildEnrichedPrompt(
      makeProject({ id: 'proj-a' }),
      makeAgent({ id: 'sub', name: 'Sub', role: 'sub' }), // no subAgents
    );

    expect(prompt).toContain('## Project agent roster');
    expect(prompt).not.toContain('### Valid `<delegate>` targets');
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
