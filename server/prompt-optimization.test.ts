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

const mockFindProject = vi.hoisted(() =>
  vi.fn((_id: string): import('./types.js').Project | null => null),
);

vi.mock('./project-model.js', () => ({
  allAgents: () => [],
  findProject: (id: string) => mockFindProject(id),
}));

import { buildEnrichedPrompt } from './chat.js';
import { getMemoryContext } from './memory.js';

beforeEach(() => {
  mockFindProject.mockReset();
  mockFindProject.mockImplementation(() => null);
});

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

  it('includes browser in ReAct example by default', () => {
    const prompt = buildEnrichedPrompt(makeProject(), makeAgent(), {
      isFirstMessage: true,
    });
    expect(prompt).toContain('## ReAct Loop');
    expect(prompt).toContain('"tool":"browser"');
  });

  it('omits browser from ReAct instructions when browserToolsEnabled is false', () => {
    const prompt = buildEnrichedPrompt(makeProject(), makeAgent({ browserToolsEnabled: false }), {
      isFirstMessage: true,
    });
    expect(prompt).toContain('## ReAct Loop');
    expect(prompt).not.toContain('"tool":"browser"');
    expect(prompt).toMatch(/browser tools.*off/i);
  });

  it('omits browser when project default disables tools and agent omits browserToolsEnabled', () => {
    mockFindProject.mockImplementation(
      () =>
        ({
          id: 'test-proj',
          browserToolsDefaultEnabled: false,
        }) as import('./types.js').Project,
    );
    const prompt = buildEnrichedPrompt(makeProject(), makeAgent(), { isFirstMessage: true });
    expect(prompt).not.toContain('"tool":"browser"');
    expect(prompt).toMatch(/browser tools.*off/i);
  });

  it('includes browser when project default is false but agent sets browserToolsEnabled true', () => {
    mockFindProject.mockImplementation(
      () =>
        ({
          id: 'test-proj',
          browserToolsDefaultEnabled: false,
        }) as import('./types.js').Project,
    );
    const prompt = buildEnrichedPrompt(makeProject(), makeAgent({ browserToolsEnabled: true }), {
      isFirstMessage: true,
    });
    expect(prompt).toContain('"tool":"browser"');
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
    writeFileSync(path.join(tmpBase, 'CLAUDE.md'), 'Repo dev guide body.');
    const first = buildEnrichedPrompt(makeProject(), makeAgent(), {
      isFirstMessage: true,
    });
    const subsequent = buildEnrichedPrompt(makeProject(), makeAgent(), {
      isFirstMessage: false,
    });
    expect(first).toContain('This is the soul.');
    expect(subsequent).toContain('This is the soul.');
    expect(first).toContain('## CLAUDE.md');
    expect(first).toContain('Repo dev guide body.');
    expect(subsequent).toContain('## CLAUDE.md');
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

describe('buildEnrichedPrompt — agent identity anchoring', () => {
  beforeEach(() => {
    mkdirSync(tmpBase, { recursive: true });
    mkdirSync(path.join(tmpBase, 'skills'), { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpBase, { recursive: true, force: true });
  });

  it('starts the prompt with a "# You are <name>" identity header', () => {
    const prompt = buildEnrichedPrompt(
      makeProject(),
      makeAgent({ id: 'pirate-bot', name: 'Pirate Bot' }),
      { isFirstMessage: true },
    );
    // The very first line must anchor the agent's name and id so that
    // downstream shared-context files (e.g. AGENTS.md) cannot silently
    // reframe who this agent is.
    expect(prompt.startsWith('# You are Pirate Bot')).toBe(true);
    expect(prompt).toMatch(/Agent id: `pirate-bot`/);
  });

  it('falls back to the agent id when name is empty', () => {
    const prompt = buildEnrichedPrompt(
      makeProject(),
      makeAgent({ id: 'no-name-agent', name: '' }),
      { isFirstMessage: true },
    );
    expect(prompt.startsWith('# You are no-name-agent')).toBe(true);
  });

  it('appends an Identity Reminder after AGENTS.md to prevent role confusion', () => {
    // Simulate the real-world failure mode: the project's AGENTS.md lists
    // several named team roles. A newly-created agent whose own systemPrompt
    // is short would otherwise latch onto one of those roles as its
    // identity. The reminder must re-pin the agent's own name/id after the
    // shared-context file has been injected.
    writeFileSync(
      path.join(tmpBase, 'AGENTS.md'),
      '# Team\n\n### Lead (team-lead)\nCoordinator.\n\n### Frontend (team-frontend)\nOwns UI.',
    );
    const prompt = buildEnrichedPrompt(
      makeProject(),
      makeAgent({ id: 'pirate-bot', name: 'Pirate Bot' }),
      { isFirstMessage: true },
    );
    expect(prompt).toContain('## AGENTS.md');
    expect(prompt).toContain('## Identity Reminder');
    const agentsIdx = prompt.indexOf('## AGENTS.md');
    const reminderIdx = prompt.indexOf('## Identity Reminder');
    // Reminder must come AFTER AGENTS.md, not before.
    expect(reminderIdx).toBeGreaterThan(agentsIdx);
    // Reminder must name the agent by name and id.
    expect(prompt).toMatch(/You are \*\*Pirate Bot\*\* \(agent id: `pirate-bot`\)/);
    expect(prompt).toMatch(/do not impersonate/i);
  });

  it('skips the Identity Reminder when no AGENTS.md is present', () => {
    // If there is no shared team file, there is no role-confusion risk
    // and emitting the reminder would just waste tokens.
    const prompt = buildEnrichedPrompt(
      makeProject(),
      makeAgent({ id: 'pirate-bot', name: 'Pirate Bot' }),
      { isFirstMessage: true },
    );
    expect(prompt).not.toContain('## Identity Reminder');
  });

  it('reminder references IDENTITY.md when present', () => {
    writeFileSync(path.join(tmpBase, 'AGENTS.md'), '# Team\n\n### Lead\nCoordinator.');
    // Mocked contextFilePath returns any file in tmpBase that exists;
    // IDENTITY.md is normally per-agent, but the mock treats all context
    // files as tmpBase-relative, which is enough to exercise the branch.
    writeFileSync(path.join(tmpBase, 'IDENTITY.md'), 'I am a pirate.');
    const prompt = buildEnrichedPrompt(
      makeProject(),
      makeAgent({ id: 'pirate-bot', name: 'Pirate Bot' }),
      { isFirstMessage: true },
    );
    expect(prompt).toContain('## Identity Reminder');
    expect(prompt).toMatch(/system prompt and IDENTITY\.md/);
  });

  it('identity anchor is present on subsequent messages too (role persistence)', () => {
    // The role anchor must NOT be gated on isFirstMessage — the agent
    // needs to know who it is on every turn, otherwise a long session
    // could drift onto a different role mid-conversation.
    const prompt = buildEnrichedPrompt(
      makeProject(),
      makeAgent({ id: 'pirate-bot', name: 'Pirate Bot' }),
      { isFirstMessage: false },
    );
    expect(prompt.startsWith('# You are Pirate Bot')).toBe(true);
  });

  it('includes the agent role in the header when set', () => {
    const prompt = buildEnrichedPrompt(
      makeProject(),
      makeAgent({ id: 'lead-1', name: 'Lead One', role: 'lead' }),
      { isFirstMessage: true },
    );
    expect(prompt).toMatch(/Role: lead/);
  });

  it('still includes the agent system prompt body below the header', () => {
    const prompt = buildEnrichedPrompt(makeProject(), makeAgent(), { isFirstMessage: false });
    // The original systemPrompt body must survive the new anchor.
    expect(prompt).toContain('You are a test agent.');
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
    execSync(
      'git init --initial-branch=main && git remote add origin https://github.com/test/repo.git',
      {
        cwd: gitTmp,
        stdio: 'pipe',
      },
    );
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

describe('buildEnrichedPrompt — tasks-only project (no GitHub)', () => {
  beforeEach(() => {
    mkdirSync(tmpBase, { recursive: true });
    mkdirSync(path.join(tmpBase, 'skills'), { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpBase, { recursive: true, force: true });
  });

  it('omits the GitHub-Connected lifecycle block when project has no githubRepo and no git remote', () => {
    // Tasks-only project: no githubRepo field set, project.cwd is not a git
    // repo at all (the bare tmpBase). The agent must NOT receive the
    // "Development Lifecycle — GitHub-Connected Project" block, because
    // there is no GitHub repo, no branches, no PRs.
    const prompt = buildEnrichedPrompt(makeProject(), makeAgent(), {
      isFirstMessage: true,
    });
    expect(prompt).not.toContain('Development Lifecycle — GitHub-Connected Project');
    // Likewise, no PR/branch imperatives should leak through.
    expect(prompt).not.toMatch(/git checkout -b feature/);
    expect(prompt).not.toMatch(/server will push.*open the PR/i);
  });

  it('omits the GitHub-Connected lifecycle block in workflow mode with no githubRepo', () => {
    const prompt = buildEnrichedPrompt(makeProject({ mode: 'workflow' }), makeAgent(), {
      isFirstMessage: true,
    });
    expect(prompt).not.toContain('Development Lifecycle — GitHub-Connected Project');
  });

  it('still includes the GitHub-Connected lifecycle block when githubRepo is set', () => {
    // Even without a real git remote on disk, an explicit githubRepo on the
    // project record should be enough to enable the lifecycle block — this
    // is the declarative path that does not depend on the working tree.
    const prompt = buildEnrichedPrompt(makeProject({ githubRepo: 'owner/repo' }), makeAgent(), {
      isFirstMessage: true,
    });
    expect(prompt).toContain('Development Lifecycle — GitHub-Connected Project');
  });
});

describe('buildEnrichedPrompt — lead agent delegation (removed)', () => {
  // The <delegate>/<handoff> sub-agent system has been removed. Lead agents
  // no longer receive a `## Delegation`, `## Sub-Agents`, or `## Handoff`
  // section in their prompt regardless of `subAgents` configuration. Only
  // the `## Lead Response Contract` (a structured-output rule) remains on
  // first-message leads.
  beforeEach(() => {
    mkdirSync(tmpBase, { recursive: true });
    mkdirSync(path.join(tmpBase, 'skills'), { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpBase, { recursive: true, force: true });
  });

  it('does NOT include delegation instructions on first message for leads', () => {
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
    expect(prompt).not.toContain('## Delegation');
    expect(prompt).not.toContain('## Sub-Agents');
    expect(prompt).not.toContain('## Handoff');
    expect(prompt).not.toContain('<delegate>');
    expect(prompt).not.toContain('<handoff>');
    // The Lead Response Contract is independent of delegation and remains.
    expect(prompt).toContain('## Lead Response Contract');
  });

  it('does NOT include a sub-agent list on subsequent messages for leads', () => {
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
    expect(prompt).not.toContain('## Sub-Agents');
    expect(prompt).not.toContain('## Delegation');
    expect(prompt).not.toContain('Guidelines');
    // Subsequent-message leads do NOT get the Lead Response Contract either
    // — that section is first-message-only.
    expect(prompt).not.toContain('## Lead Response Contract');
  });
});

describe('buildEnrichedPrompt — Lead Response Contract Next-step hygiene', () => {
  // The Lead Response Contract used to mandate `Next step` on every
  // non-trivial response ("Do not omit `Evidence` or `Next step`."), which
  // trained leads to end turns by *naming* a follow-up rather than executing
  // it — directly competing with the Bias to Action section. The contract
  // now marks `Next step` as optional + explicitly forbids using it as a
  // parking lot for work the agent could have done in the same turn.
  beforeEach(() => {
    mkdirSync(tmpBase, { recursive: true });
    mkdirSync(path.join(tmpBase, 'skills'), { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpBase, { recursive: true, force: true });
  });

  function leadFirstMessagePrompt(): string {
    return buildEnrichedPrompt(makeProject(), makeAgent({ role: 'lead' }), {
      isFirstMessage: true,
    });
  }

  it('marks Next step as optional and not a mandatory heading', () => {
    const prompt = leadFirstMessagePrompt();
    // Old wording forced the heading on every response — that line is gone.
    expect(prompt).not.toContain('Do not omit `Evidence` or `Next step`.');
    // New contract still requires Evidence...
    expect(prompt).toContain('Do not omit `Evidence`');
    // ...but explicitly flags Next step as optional.
    expect(prompt).toMatch(/`Next step` is optional/);
  });

  it('explicitly tells the lead: if Next step is doable now, do it in this turn', () => {
    const prompt = leadFirstMessagePrompt();
    // The contract must call out the parking-lot anti-pattern...
    expect(prompt).toMatch(/parking lot/i);
    // ...and instruct the agent to execute the work in the same turn rather
    // than emit a "Next step: …" line for something it could have done.
    expect(prompt).toMatch(/do it in this turn/i);
    // And it should fold the executed work back into Actions taken / Result.
    expect(prompt).toMatch(/`Actions taken`/);
    expect(prompt).toMatch(/`Result`/);
  });

  it('describes the legitimate uses of Next step (deferred work only)', () => {
    const prompt = leadFirstMessagePrompt();
    // Genuinely deferred work — follow-up cards, user questions, blocked
    // hand-offs — is the only category that should appear under Next step.
    expect(prompt).toMatch(/genuinely deferred/i);
    expect(prompt).toMatch(/follow-up card/i);
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
