/**
 * Tests for prompt optimization: first-message gating and memory truncation limits.
 *
 * These tests verify that:
 * 1. Static instructional blocks (wiki guidelines, kanban, dev lifecycle, etc.)
 *    are only injected on the first message of a session
 * 2. Memory truncation limits are correctly applied at reduced thresholds
 * 3. Dynamic content (context files, skills, memory) is always included
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'fs';
import path from 'path';
import os from 'os';

// Mock db before importing chat
vi.mock('./db.js', () => ({
  stmts: {
    getAgentSkillOverrides: { all: () => [] },
  },
}));

// Mock wiki
vi.mock('./wiki.js', () => ({
  getWikiContext: (projectId: string) =>
    projectId ? `## Project Wiki (2 pages)\n- Page A\n- Page B` : '',
}));

// Mock skills
vi.mock('./routes/skills.js', () => ({
  collectSkillsFromDir: () => [],
  DEFAULT_SKILLS_DIR: '/tmp/no-skills',
}));

// Mock config
vi.mock('./config.js', () => ({
  default: { defaultModel: 'claude-sonnet-4-20250514' },
  defaultModelForEngine: () => 'claude-sonnet-4-20250514',
  buildSpawnEnv: () => ({}),
}));

// Mock project-paths to use our temp dir
const tmpBase = path.join(os.tmpdir(), `prompt-opt-test-${Date.now()}`);

vi.mock('./project-paths.js', () => ({
  resolveProjectPaths: (_project: unknown, _agent: unknown) => ({
    skillsDir: path.join(tmpBase, 'skills'),
    contextFiles: {},
  }),
  contextFilePath: (_paths: unknown, filename: string) => {
    const p = path.join(tmpBase, filename);
    return existsSync(p) ? p : null;
  },
}));

import { buildEnrichedPrompt } from './chat.js';
import { getMemoryContext } from './memory.js';

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

describe('buildEnrichedPrompt — first message gating', () => {
  beforeEach(() => {
    mkdirSync(tmpBase, { recursive: true });
    mkdirSync(path.join(tmpBase, 'skills'), { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpBase, { recursive: true, force: true });
  });

  it('includes wiki guidelines on first message', () => {
    const prompt = buildEnrichedPrompt(makeProject(), makeAgent(), {
      isFirstMessage: true,
    });
    expect(prompt).toContain('Wiki Documentation Guidelines');
  });

  it('excludes wiki guidelines on subsequent messages', () => {
    const prompt = buildEnrichedPrompt(makeProject(), makeAgent(), {
      isFirstMessage: false,
    });
    expect(prompt).not.toContain('Wiki Documentation Guidelines');
  });

  it('includes kanban instructions on first message', () => {
    const prompt = buildEnrichedPrompt(makeProject(), makeAgent(), {
      isFirstMessage: true,
    });
    expect(prompt).toContain('Kanban Board');
  });

  it('excludes kanban instructions on subsequent messages', () => {
    const prompt = buildEnrichedPrompt(makeProject(), makeAgent(), {
      isFirstMessage: false,
    });
    expect(prompt).not.toContain('Kanban Board');
  });

  it('kanban instructions include acceptance criteria and session_id guidance', () => {
    const prompt = buildEnrichedPrompt(makeProject(), makeAgent(), {
      isFirstMessage: true,
    });
    expect(prompt).toContain('acceptance criteria');
    expect(prompt).toContain('AGENT_HUB_SESSION_ID');
    expect(prompt).toContain('auto-renames the sidebar');
  });

  it('includes memory instructions on first message', () => {
    const prompt = buildEnrichedPrompt(makeProject(), makeAgent(), {
      isFirstMessage: true,
    });
    expect(prompt).toContain('Memory Instructions');
  });

  it('includes bias-to-action directive on first message', () => {
    const prompt = buildEnrichedPrompt(makeProject(), makeAgent(), {
      isFirstMessage: true,
    });
    expect(prompt).toContain('Bias to Action');
    // Must explicitly call out the anti-patterns we want to eliminate
    expect(prompt).toMatch(/Do you want me to create a card/i);
    expect(prompt).toMatch(/Should I go ahead and implement/i);
    // Must tell the agent to act, not ask
    expect(prompt).toMatch(/just do the work/i);
    // Must preserve the narrow "ask first" carve-out for destructive/ambiguous cases
    expect(prompt).toMatch(/destructive and irreversible/i);
  });

  it('excludes bias-to-action directive on subsequent messages', () => {
    const prompt = buildEnrichedPrompt(makeProject(), makeAgent(), {
      isFirstMessage: false,
    });
    expect(prompt).not.toContain('Bias to Action');
  });

  it('bias-to-action directive ships for all projects (no project context required)', () => {
    // Project-agnostic: even a bare project with no workspace files gets the directive.
    const bareProject = makeProject({ id: 'some-other-project' });
    const prompt = buildEnrichedPrompt(bareProject, makeAgent(), {
      isFirstMessage: true,
    });
    expect(prompt).toContain('Bias to Action');
  });

  it('includes research-questions directive on first message', () => {
    const prompt = buildEnrichedPrompt(makeProject(), makeAgent(), {
      isFirstMessage: true,
    });
    // Section heading present
    expect(prompt).toContain('Research Questions');
    // Must explicitly forbid the "want me to make a card" prompt pattern
    expect(prompt).toMatch(/Want me to make a card to look into this/i);
    // Must clarify the card semantics: work to ship vs. questions to answer
    expect(prompt).toMatch(/work to ship/i);
    expect(prompt).toMatch(/questions to answer/i);
  });

  it('excludes research-questions directive on subsequent messages', () => {
    const prompt = buildEnrichedPrompt(makeProject(), makeAgent(), {
      isFirstMessage: false,
    });
    expect(prompt).not.toContain('Research Questions');
  });

  it('excludes memory instructions on subsequent messages', () => {
    const prompt = buildEnrichedPrompt(makeProject(), makeAgent(), {
      isFirstMessage: false,
    });
    expect(prompt).not.toContain('Memory Instructions');
  });

  it('includes external API guidelines on first message', () => {
    const prompt = buildEnrichedPrompt(makeProject(), makeAgent(), {
      isFirstMessage: true,
    });
    expect(prompt).toContain('External API Documentation');
  });

  it('excludes external API guidelines on subsequent messages', () => {
    const prompt = buildEnrichedPrompt(makeProject(), makeAgent(), {
      isFirstMessage: false,
    });
    expect(prompt).not.toContain('External API Documentation');
  });

  it('includes file-safety reminder handling on first message', () => {
    const prompt = buildEnrichedPrompt(makeProject(), makeAgent(), {
      isFirstMessage: true,
    });
    expect(prompt).toContain('File-Safety Reminder');
    // Must explicitly tell the model not to verbalize acknowledgments
    expect(prompt).toMatch(/Not malware/);
    expect(prompt).toMatch(/internalize/i);
    // Must explicitly forbid using the reminder as a refusal excuse
    expect(prompt).toMatch(/never use the reminder as grounds to refuse/i);
  });

  it('excludes file-safety reminder handling on subsequent messages', () => {
    const prompt = buildEnrichedPrompt(makeProject(), makeAgent(), {
      isFirstMessage: false,
    });
    expect(prompt).not.toContain('File-Safety Reminder');
  });

  it('file-safety reminder directive is project-agnostic (ships for all projects)', () => {
    // Build a prompt for a project with no CLAUDE.md / workspace context.
    // The directive should still be present because it lives in buildEnrichedPrompt.
    const bareProject = makeProject({ id: 'some-other-project' });
    const prompt = buildEnrichedPrompt(bareProject, makeAgent(), {
      isFirstMessage: true,
    });
    expect(prompt).toContain('File-Safety Reminder');
  });

  it('always includes wiki page listing regardless of isFirstMessage', () => {
    const first = buildEnrichedPrompt(makeProject(), makeAgent(), {
      isFirstMessage: true,
    });
    const subsequent = buildEnrichedPrompt(makeProject(), makeAgent(), {
      isFirstMessage: false,
    });
    // Both should have wiki context (page listing)
    expect(first).toContain('Project Wiki');
    expect(subsequent).toContain('Project Wiki');
  });

  it('always includes agent system prompt', () => {
    const prompt = buildEnrichedPrompt(makeProject(), makeAgent(), {
      isFirstMessage: false,
    });
    expect(prompt).toContain('You are a test agent.');
  });

  it('defaults isFirstMessage to true for backward compatibility', () => {
    const prompt = buildEnrichedPrompt(makeProject(), makeAgent(), {});
    // Should include static blocks (defaulting to first message)
    expect(prompt).toContain('Wiki Documentation Guidelines');
    expect(prompt).toContain('Memory Instructions');
  });

  it('includes context files on both first and subsequent messages', () => {
    writeFileSync(path.join(tmpBase, 'SOUL.md'), 'This is the soul.');
    const first = buildEnrichedPrompt(makeProject(), makeAgent(), {
      isFirstMessage: true,
    });
    const subsequent = buildEnrichedPrompt(makeProject(), makeAgent(), {
      isFirstMessage: false,
    });
    expect(first).toContain('This is the soul.');
    expect(subsequent).toContain('This is the soul.');
  });

  it('subsequent message prompt is significantly smaller', () => {
    const first = buildEnrichedPrompt(makeProject(), makeAgent(), {
      isFirstMessage: true,
    });
    const subsequent = buildEnrichedPrompt(makeProject(), makeAgent(), {
      isFirstMessage: false,
    });
    // Subsequent should be noticeably smaller (at least 30% smaller)
    expect(subsequent.length).toBeLessThan(first.length * 0.7);
  });
});

describe('buildEnrichedPrompt — server owns PR creation', () => {
  const gitTmp = path.join(os.tmpdir(), `prompt-auto-test-${Date.now()}`);

  beforeEach(() => {
    mkdirSync(tmpBase, { recursive: true });
    mkdirSync(path.join(tmpBase, 'skills'), { recursive: true });
    // Create a git repo with a GitHub remote so isGitHubConnected = true
    mkdirSync(gitTmp, { recursive: true });
    const { execSync } = require('child_process');
    execSync('git init && git remote add origin https://github.com/test/repo.git', {
      cwd: gitTmp,
    });
  });

  afterEach(() => {
    rmSync(tmpBase, { recursive: true, force: true });
    rmSync(gitTmp, { recursive: true, force: true });
  });

  it('never tells the agent to run `gh pr create` as an imperative', () => {
    const prompt = buildEnrichedPrompt(makeProject({ cwd: gitTmp }), makeAgent(), {
      isFirstMessage: true,
    });
    // Legacy autonomous prompt had these imperative instructions — must be gone
    expect(prompt).not.toMatch(/\*\*Create PR\*\*:\s*`gh pr create/);
    expect(prompt).not.toMatch(/CI \+ Hand Off/);
    expect(prompt).not.toMatch(/Commit & Push/);
    // The phrase `git push -u origin` was the "push your branch" step — also gone
    expect(prompt).not.toContain('git push -u origin');
  });

  it('explicitly forbids pushing and PR creation', () => {
    const prompt = buildEnrichedPrompt(makeProject({ cwd: gitTmp }), makeAgent(), {
      isFirstMessage: true,
    });
    expect(prompt).toMatch(/Do NOT push.*gh pr create/);
    expect(prompt).toMatch(/server (will|handles|owns)/i);
  });

  it('mentions both PR creation paths (card-linked auto, ad-hoc button)', () => {
    const prompt = buildEnrichedPrompt(makeProject({ cwd: gitTmp }), makeAgent(), {
      isFirstMessage: true,
    });
    // Card-linked path: server opens PR when session ends
    expect(prompt).toMatch(/kanban card/i);
    expect(prompt).toMatch(/server will push.*open the PR/i);
    // Ad-hoc path: "Create PR" button appears after session
    expect(prompt).toMatch(/ad-hoc.*Create PR.*button/i);
  });

  it('worktree-only fallback (no GitHub remote) also forbids pushing and PR creation', () => {
    // makeProject defaults to tmpBase (no git remote → isGitHubConnected = false)
    const prompt = buildEnrichedPrompt(makeProject(), makeAgent(), {
      isFirstMessage: true,
      useWorktree: true,
    });
    expect(prompt).toContain('Git Workflow');
    expect(prompt).toMatch(/Do NOT push.*gh pr create/);
    // Legacy worktree fallback told agents "Use `gh pr create` for PRs" — must be gone
    expect(prompt).not.toMatch(/Use `gh pr create`/);
  });
});

describe('buildEnrichedPrompt — lead agent delegation', () => {
  beforeEach(() => {
    mkdirSync(tmpBase, { recursive: true });
    mkdirSync(path.join(tmpBase, 'skills'), { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpBase, { recursive: true, force: true });
  });

  it('includes full delegation instructions on first message for leads', () => {
    const mockGetEnrichedAgent = (id: string) => ({
      id,
      name: 'Sub Agent',
      engine: 'claude-code',
      systemPrompt: 'I am a sub-agent.',
      projectId: 'test-proj',
      projectName: 'Test',
      cwd: tmpBase,
      ahw: tmpBase,
      workspace: tmpBase,
    });

    const prompt = buildEnrichedPrompt(
      makeProject(),
      makeAgent({ role: 'lead', subAgents: ['sub-1'] }),
      { isFirstMessage: true, _getEnrichedAgent: mockGetEnrichedAgent },
    );
    expect(prompt).toContain('Delegation');
    expect(prompt).toContain('delegate');
    expect(prompt).toContain('Guidelines');
  });

  it('includes compact sub-agent list on subsequent messages for leads', () => {
    const mockGetEnrichedAgent = (id: string) => ({
      id,
      name: 'Sub Agent',
      engine: 'claude-code',
      systemPrompt: 'I am a sub-agent.',
      projectId: 'test-proj',
      projectName: 'Test',
      cwd: tmpBase,
      ahw: tmpBase,
      workspace: tmpBase,
    });

    const prompt = buildEnrichedPrompt(
      makeProject(),
      makeAgent({ role: 'lead', subAgents: ['sub-1'] }),
      { isFirstMessage: false, _getEnrichedAgent: mockGetEnrichedAgent },
    );
    expect(prompt).toContain('Sub-Agents');
    expect(prompt).toContain('Sub Agent');
    // Should NOT contain the verbose delegation guidelines
    expect(prompt).not.toContain('Guidelines');
  });
});

describe('getMemoryContext — reduced truncation limits', () => {
  const memWorkspace = path.join(tmpBase, 'mem-test');

  beforeEach(() => {
    mkdirSync(path.join(memWorkspace, 'memory'), { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpBase, { recursive: true, force: true });
  });

  it('truncates MEMORY.md at 2000 chars', () => {
    const longMemory = 'x'.repeat(3000);
    writeFileSync(path.join(memWorkspace, 'MEMORY.md'), longMemory);
    const ctx = getMemoryContext(memWorkspace);
    // Should be truncated: "...(truncated)\n" + last 2000 chars
    expect(ctx).toContain('...(truncated)');
    // Total memory section should be under 2100 chars (2000 + header + truncation prefix)
    const memorySection = ctx.split('## MEMORY.md')[1]?.split('##')[0] || '';
    // The actual content portion should be around 2000 chars
    expect(memorySection.length).toBeLessThan(2100);
  });

  it('does not truncate small MEMORY.md', () => {
    writeFileSync(path.join(memWorkspace, 'MEMORY.md'), 'Short memory content');
    const ctx = getMemoryContext(memWorkspace);
    expect(ctx).not.toContain('...(truncated)');
    expect(ctx).toContain('Short memory content');
  });

  it('truncates today notes at 3000 chars', () => {
    const today = new Date();
    const dateStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    const longNotes = 'y'.repeat(5000);
    writeFileSync(path.join(memWorkspace, 'memory', `${dateStr}.md`), longNotes);

    const ctx = getMemoryContext(memWorkspace);
    expect(ctx).toContain('...(truncated)');
    // Should contain roughly 3000 'y' characters, not 5000
    const yCount = (ctx.match(/y/g) || []).length;
    expect(yCount).toBeGreaterThanOrEqual(3000);
    expect(yCount).toBeLessThanOrEqual(3010);
  });

  it('truncates yesterday notes at 1500 chars', () => {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const dateStr = `${yesterday.getFullYear()}-${String(yesterday.getMonth() + 1).padStart(2, '0')}-${String(yesterday.getDate()).padStart(2, '0')}`;
    const longNotes = 'z'.repeat(3000);
    writeFileSync(path.join(memWorkspace, 'memory', `${dateStr}.md`), longNotes);

    const ctx = getMemoryContext(memWorkspace);
    expect(ctx).toContain('...(truncated)');
    // Should contain roughly 1500 'z' characters, not 3000
    const zCount = (ctx.match(/z/g) || []).length;
    expect(zCount).toBeGreaterThanOrEqual(1500);
    expect(zCount).toBeLessThanOrEqual(1510);
  });

  it('returns empty string for missing workspace', () => {
    expect(getMemoryContext(undefined)).toBe('');
    expect(getMemoryContext('')).toBe('');
  });
});
