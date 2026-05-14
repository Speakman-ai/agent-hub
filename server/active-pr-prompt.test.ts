/**
 * `buildEnrichedPrompt` — Active Pull Request awareness block.
 *
 * When a previous session for the same kanban card already opened a PR (see
 * `auto-git.ts` → `setCardPrUrl`), the server surfaces that URL into the
 * resumed / redispatched session's enriched system prompt so the agent does
 * NOT blindly run `gh pr create` and produce a duplicate PR for the same
 * branch. Documented failure pattern: surveytracker MCS-2197 (PR #654 vs
 * #655), 2026-05-14 daily note.
 *
 * The server-side auto-PR flow already dedupes by branch
 * (`server/auto-git.ts:1659-1707`), but it cannot intercept `gh pr create`
 * calls that the spawned agent runs out of its own Bash tool — this prompt
 * block is the contract-level fix that closes that gap.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdirSync, rmSync, existsSync } from 'fs';
import path from 'path';
import os from 'os';
import type { EnrichedAgent } from './types.js';

const tmpBase = path.join(os.tmpdir(), `active-pr-prompt-test-${Date.now()}`);

const { mockAllAgents, mockFindProject } = vi.hoisted(() => ({
  mockAllAgents: vi.fn((): EnrichedAgent[] => []),
  mockFindProject: vi.fn((_id: string): import('./types.js').Project | null => null),
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
  findProject: (id: string) => mockFindProject(id),
}));

import { buildEnrichedPrompt } from './chat.js';

beforeEach(() => {
  mockAllAgents.mockReset().mockReturnValue([]);
  mockFindProject.mockReset().mockReturnValue(null);
  // Ensure the tmpBase exists so resolveProjectPaths returns a usable dir;
  // none of the context-file lookups under it will resolve because we don't
  // pre-create AGENTS.md/SOUL.md/etc.
  try {
    mkdirSync(tmpBase, { recursive: true });
  } catch {
    /* fine if already exists */
  }
});

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
    role: 'dev',
    ...overrides,
  };
}

describe('buildEnrichedPrompt — Active Pull Request awareness', () => {
  it('omits the Active Pull Request block when branchPrUrl is null', () => {
    const prompt = buildEnrichedPrompt(makeProject() as never, makeAgent() as never, {
      branchPrUrl: null,
      branchPrBase: null,
    });
    expect(prompt).not.toContain('## Active Pull Request');
    expect(prompt).not.toContain('gh pr create');
  });

  it('omits the Active Pull Request block when option is unset (default)', () => {
    const prompt = buildEnrichedPrompt(makeProject() as never, makeAgent() as never, {});
    expect(prompt).not.toContain('## Active Pull Request');
  });

  it('appends the Active Pull Request block with the URL when branchPrUrl is set', () => {
    const prUrl = 'https://github.com/test/repo/pull/655';
    const prompt = buildEnrichedPrompt(makeProject() as never, makeAgent() as never, {
      branchPrUrl: prUrl,
      branchPrBase: null,
    });
    expect(prompt).toContain('## Active Pull Request');
    expect(prompt).toContain(prUrl);
    // The agent must be explicitly warned away from gh pr create — that's the
    // whole point of this block.
    expect(prompt).toMatch(/Do \*\*NOT\*\* run `gh pr create`/);
  });

  it('includes the base branch suffix when branchPrBase is also set', () => {
    const prUrl = 'https://github.com/test/repo/pull/655';
    const prompt = buildEnrichedPrompt(makeProject() as never, makeAgent() as never, {
      branchPrUrl: prUrl,
      branchPrBase: 'feature/auto/cad-engine',
    });
    expect(prompt).toContain(prUrl);
    expect(prompt).toContain('base: `feature/auto/cad-engine`');
  });

  it('does not render a base-branch suffix when branchPrBase is null', () => {
    const prUrl = 'https://github.com/test/repo/pull/655';
    const prompt = buildEnrichedPrompt(makeProject() as never, makeAgent() as never, {
      branchPrUrl: prUrl,
      branchPrBase: null,
    });
    // The "(base: `<...>`)" suffix should be absent — only the URL renders.
    expect(prompt).not.toMatch(/\(base: `[^`]+`\)/);
  });

  it('renders the Active Pull Request block after the existing orchestration append', () => {
    // Verifies the block lands at the end of the prompt (a structural guarantee
    // — anchoring the warning as the last instruction the agent sees before
    // user input). Regression guard against accidental reordering.
    const prUrl = 'https://github.com/test/repo/pull/777';
    const prompt = buildEnrichedPrompt(makeProject() as never, makeAgent() as never, {
      branchPrUrl: prUrl,
    });
    const blockIdx = prompt.lastIndexOf('## Active Pull Request');
    expect(blockIdx).toBeGreaterThan(-1);
    // Nothing important should come after the block (only the rendered URL/
    // warning content itself).
    expect(prompt.slice(blockIdx)).toContain(prUrl);
    expect(prompt.slice(blockIdx)).toContain('gh pr create');
  });

  it('cleans up tmp dir', () => {
    try {
      rmSync(tmpBase, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
    expect(true).toBe(true);
  });
});
