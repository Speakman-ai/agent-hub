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
  db: {},
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

  it('does not advertise previews for an empty dev-server config', () => {
    const prompt = buildEnrichedPrompt(makeProject({ prEnv: { devServer: {} } }), makeAgent(), {
      isFirstMessage: true,
    });

    expect(prompt).not.toContain('`preview` — observe and drive');
    expect(prompt).not.toContain('## Worktree preview (lifecycle is human-only)');
  });

  it('does not advertise previews for a whitespace-only start command', () => {
    const prompt = buildEnrichedPrompt(
      makeProject({ prEnv: { devServer: { startCommand: '   ' } } }),
      makeAgent(),
      { isFirstMessage: true },
    );

    expect(prompt).not.toContain('`preview` — observe and drive');
    expect(prompt).not.toContain('## Worktree preview (lifecycle is human-only)');
  });

  it('surfaces an early "Browser Automation Available" callout above the ReAct Loop section on first message', () => {
    const prompt = buildEnrichedPrompt(makeProject(), makeAgent(), {
      isFirstMessage: true,
    });
    expect(prompt).toContain('## Browser Automation Available');
    // The callout must appear BEFORE the detailed ReAct Loop section so
    // it's the first thing the model sees when scanning the prompt for
    // capability hints. If both are present, the callout's index must
    // be strictly less than the ReAct Loop section's index.
    const calloutIdx = prompt.indexOf('## Browser Automation Available');
    const reactIdx = prompt.indexOf('## ReAct Loop');
    expect(calloutIdx).toBeGreaterThanOrEqual(0);
    expect(reactIdx).toBeGreaterThan(calloutIdx);
    // Anti-refusal phrasing must be present so the model doesn't fall
    // back to "I can't access URLs" responses.
    expect(prompt).toMatch(/do not claim you lack web access/i);
    // Must include a concrete `browser` action example so the model
    // doesn't have to scroll to the ReAct Loop bullet list to learn
    // the JSON shape.
    expect(prompt).toContain('"tool":"browser"');
    expect(prompt).toContain('"op":"navigate"');
  });

  it('omits the "Browser Automation Available" callout when browser tools are disabled for the agent', () => {
    const prompt = buildEnrichedPrompt(makeProject(), makeAgent({ browserToolsEnabled: false }), {
      isFirstMessage: true,
    });
    expect(prompt).not.toContain('## Browser Automation Available');
  });

  it('omits the "Browser Automation Available" callout on subsequent (non-first) messages', () => {
    const prompt = buildEnrichedPrompt(makeProject(), makeAgent(), {
      isFirstMessage: false,
    });
    expect(prompt).not.toContain('## Browser Automation Available');
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

  // Regression: when a session is spawned from a kanban-card assignment,
  // `kanban_cards.session_id` already links the card. The prompt builder
  // must not instruct the agent to file *another* card — that produces
  // duplicate cards and breaks the auto-link/auto-PR/auto-Done flow.
  it('suppresses "create a card" instructions when sessionHasLinkedCard is true', () => {
    const prompt = buildEnrichedPrompt(makeProject({ githubRepo: 'owner/repo' }), makeAgent(), {
      isFirstMessage: true,
      sessionHasLinkedCard: true,
    });
    // Section headings still ship — only the wording inside changes.
    expect(prompt).toContain('Kanban Board');
    expect(prompt).toContain('Bias to Action');
    expect(prompt).toContain('Development Lifecycle');

    // The "already linked" reframe must be present, and tell the agent
    // explicitly NOT to create a card.
    expect(prompt).toMatch(/already linked to a (kanban )?card/i);
    expect(prompt).toMatch(/do NOT create a (new |another )?(kanban )?card/i);

    // The create-a-card phrasings used in the default branch must be
    // absent so the model has only one consistent signal.
    expect(prompt).not.toMatch(/^1\. Create the kanban card/m);
    expect(prompt).not.toContain('auto-renames the sidebar');
  });

  it('keeps "create a card" instructions when sessionHasLinkedCard is false / unset', () => {
    const prompt = buildEnrichedPrompt(makeProject({ githubRepo: 'owner/repo' }), makeAgent(), {
      isFirstMessage: true,
    });
    // Default path keeps the canonical wording exercised by other tests.
    expect(prompt).toContain('auto-renames the sidebar');
    expect(prompt).toMatch(/^1\. Create the kanban card/m);
    // And does NOT inject the "already linked" override.
    expect(prompt).not.toMatch(/already linked to a (kanban )?card/i);
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
    // (post-May-2026 trim: phrasings collapsed into a single inline list).
    expect(prompt).toMatch(/Do you want me to create a card/i);
    expect(prompt).toMatch(/Should I implement this/i);
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
    // Must forbid offering to open a ticket for the investigation itself.
    // Post-May-2026 trim: the directive is one paragraph rather than a
    // bullet list, so we assert on the intent rather than specific
    // phrasings the bullet form used to carry.
    expect(prompt).toMatch(/offer to open a ticket/i);
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

  it('includes no-shell directive on first message', () => {
    // The user talks to agents through a web/chat UI and has no shell. Agents
    // must run commands themselves rather than instructing the user to.
    const prompt = buildEnrichedPrompt(makeProject(), makeAgent(), {
      isFirstMessage: true,
    });
    // Section heading present
    expect(prompt).toContain('No Shell');
    // Must explicitly state the user lacks shell access
    expect(prompt).toMatch(/no shell access/i);
    // Must tell the agent to run the command itself rather than instruct the user
    expect(prompt).toMatch(/run it yourself/i);
  });

  it('excludes no-shell directive on subsequent messages', () => {
    const prompt = buildEnrichedPrompt(makeProject(), makeAgent(), {
      isFirstMessage: false,
    });
    expect(prompt).not.toContain('No Shell');
  });

  it('no-shell directive ships for all projects (no project context required)', () => {
    // Project-agnostic: bare project with no workspace files still gets it.
    const bareProject = makeProject({ id: 'some-other-project' });
    const prompt = buildEnrichedPrompt(bareProject, makeAgent(), {
      isFirstMessage: true,
    });
    expect(prompt).toContain('No Shell');
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

  it('folds file-safety reminder handling into the writing-style block on first message', () => {
    // Post-May-2026 prompt-trim audit: the standalone "File-Safety
    // Reminder" block was deleted and its single load-bearing rule
    // ("internalize the hidden CLI reminder, never surface it, never
    // refuse routine work because of it") was merged into rule 5 of the
    // Writing Style block. The directive must still be present, just in
    // the new home.
    const prompt = buildEnrichedPrompt(makeProject(), makeAgent(), {
      isFirstMessage: true,
    });
    expect(prompt).not.toContain('File-Safety Reminder');
    expect(prompt).toContain('Writing Style');
    expect(prompt).toMatch(/Not malware/);
    expect(prompt).toMatch(/internalize/i);
    expect(prompt).toMatch(/never (use them|refuse)/i);
  });

  it('excludes file-safety reminder block on subsequent messages', () => {
    const prompt = buildEnrichedPrompt(makeProject(), makeAgent(), {
      isFirstMessage: false,
    });
    expect(prompt).not.toContain('File-Safety Reminder');
  });

  it('includes writing-style anti-slop block on first message', () => {
    const prompt = buildEnrichedPrompt(makeProject(), makeAgent(), {
      isFirstMessage: true,
    });
    // Section heading present.
    expect(prompt).toContain('Writing Style');
    expect(prompt).toContain('No AI Slop');
    // Must explicitly forbid em-dashes and en-dashes
    // (post-May-2026 trim: phrasing collapsed to "No em/en-dashes").
    expect(prompt).toMatch(/No em\/en-dashes/i);
    expect(prompt).toContain('\u2014'); // em-dash character shown as the forbidden glyph
    expect(prompt).toContain('\u2013'); // en-dash character shown as the forbidden glyph
    // Must still call out the canonical slop patterns.
    expect(prompt).toMatch(/preambles, recaps, or hedges/i);
    expect(prompt).toMatch(/No buzzword vocabulary/i);
    expect(prompt).toMatch(/No bullet soup/i);
    expect(prompt).toMatch(/Internalize hidden CLI reminders/i);
    // Rules added for forced triads, bloated comments, and temporal breadcrumbs.
    expect(prompt).toMatch(/No forced triads/i);
    expect(prompt).toMatch(/rule of three/i);
    expect(prompt).toMatch(/No bloated comments/i);
    expect(prompt).toMatch(/breadcrumbs in code or copy/i);
    expect(prompt).toMatch(/legacy/i);
    expect(prompt).toContain('`v0`/`v1`/`v2`');
    // The warranted-exception escape hatch must survive.
    expect(prompt).toMatch(/100%-warranted exception/i);
  });

  it('excludes writing-style anti-slop block on subsequent messages', () => {
    const prompt = buildEnrichedPrompt(makeProject(), makeAgent(), {
      isFirstMessage: false,
    });
    expect(prompt).not.toContain('No AI Slop');
  });

  it('writing-style block ships for all projects (no project context required)', () => {
    const bareProject = makeProject({ id: 'some-other-project' });
    const prompt = buildEnrichedPrompt(bareProject, makeAgent(), {
      isFirstMessage: true,
    });
    expect(prompt).toContain('No AI Slop');
  });

  it('file-safety guidance is project-agnostic via the writing-style block', () => {
    // Build a prompt for a project with no CLAUDE.md / workspace context.
    // The directive should still be present because it lives inside the
    // Writing Style block (rule 5), which itself is project-agnostic.
    const bareProject = makeProject({ id: 'some-other-project' });
    const prompt = buildEnrichedPrompt(bareProject, makeAgent(), {
      isFirstMessage: true,
    });
    expect(prompt).not.toContain('File-Safety Reminder');
    expect(prompt).toContain('Writing Style');
    expect(prompt).toMatch(/Internalize hidden CLI reminders/i);
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

  it('includes identity context files on both first and subsequent messages', () => {
    // Identity / team files (AGENTS.md, SOUL.md, IDENTITY.md) ship on
    // every turn because the model regularly role-confuses without the
    // mid-prompt identity anchor. CLAUDE.md (repo dev guide, ~22 KB on
    // agent-hub) is gated to first-message only by the May 2026 trim
    // audit since its dev-loop guidance only needs to be absorbed once
    // per session.
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
    // CLAUDE.md is first-message-only after the trim.
    expect(subsequent).not.toContain('## CLAUDE.md');
    expect(subsequent).not.toContain('Repo dev guide body.');
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

describe('buildEnrichedPrompt — agent-owned PR shipping', () => {
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

  it('includes explicit PR shipping guidance (rebase/push/create)', () => {
    const prompt = buildEnrichedPrompt(makeProject({ cwd: gitTmp }), makeAgent(), {
      isFirstMessage: true,
    });
    expect(prompt).toMatch(/rebase on latest `origin\/main`/i);
    expect(prompt).toMatch(/open the PR with `gh pr create`/i);
    expect(prompt).toMatch(/Summary.*Test plan/i);
  });

  it('uses the detected default branch (e.g. master) instead of hardcoded main', () => {
    const prompt = buildEnrichedPrompt(makeProject({ cwd: gitTmp }), makeAgent(), {
      isFirstMessage: true,
      defaultBranch: 'master',
    });
    expect(prompt).toMatch(/git checkout master && git pull/i);
    expect(prompt).toMatch(/rebase on latest `origin\/master`/i);
    expect(prompt).not.toMatch(/git checkout main &&/i);
  });

  it('omits all branch/ship guidance for non-shipping helpers (omitDevLifecycle)', () => {
    const prompt = buildEnrichedPrompt(makeProject({ cwd: gitTmp }), makeAgent(), {
      isFirstMessage: true,
      omitDevLifecycle: true,
    });
    expect(prompt).not.toMatch(/Development Lifecycle/i);
    expect(prompt).not.toMatch(/git checkout/i);
    expect(prompt).not.toMatch(/origin\/(main|master)/i);
    expect(prompt).not.toMatch(/gh pr create/i);
  });

  it('prefers an explicit branchPrBase override over the detected default branch', () => {
    const prompt = buildEnrichedPrompt(makeProject({ cwd: gitTmp }), makeAgent(), {
      isFirstMessage: true,
      defaultBranch: 'master',
      branchPrBase: 'release/2.0',
    });
    expect(prompt).toMatch(/git checkout release\/2\.0 && git pull/i);
    expect(prompt).toMatch(/rebase on latest `origin\/release\/2\.0`/i);
  });

  it('requires shipping while forbidding self-merge', () => {
    const prompt = buildEnrichedPrompt(makeProject({ cwd: gitTmp }), makeAgent(), {
      isFirstMessage: true,
    });
    expect(prompt).toMatch(/commit, push, and open the PR/i);
    expect(prompt).toMatch(/Never merge your own PR/i);
  });

  it('worktree-only fallback (no GitHub remote) still describes agent-owned shipping', () => {
    // makeProject defaults to tmpBase (no git remote → isGitHubConnected = false)
    const prompt = buildEnrichedPrompt(makeProject(), makeAgent(), {
      isFirstMessage: true,
      useWorktree: true,
    });
    expect(prompt).toContain('Git Workflow');
    expect(prompt).toMatch(/rebasing on `origin\/main`, pushing, and opening\/updating a PR/i);
    expect(prompt).toMatch(/Do not merge your own PR/i);
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
    expect(prompt).not.toMatch(/open the PR with `gh pr create`/i);
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

describe('buildEnrichedPrompt — lead response contract', () => {
  beforeEach(() => {
    mkdirSync(tmpBase, { recursive: true });
    mkdirSync(path.join(tmpBase, 'skills'), { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpBase, { recursive: true, force: true });
  });

  it('includes the lead response contract on the first message', () => {
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

    const prompt = buildEnrichedPrompt(makeProject(), makeAgent({ role: 'lead' }), {
      isFirstMessage: true,
      _getEnrichedAgent: mockGetEnrichedAgent,
    });
    expect(prompt).toContain('## Lead Response Contract');
  });

  it('does not include the lead response contract on subsequent messages', () => {
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

    const prompt = buildEnrichedPrompt(makeProject(), makeAgent({ role: 'lead' }), {
      isFirstMessage: false,
      _getEnrichedAgent: mockGetEnrichedAgent,
    });
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

// ──────────────────────────────────────────────────────────────────
// Enriched prompt size observability
//
// Pairs with the May 14 2026 audit. The argv soft cap at 100 KB was the
// only existing signal for prompt bloat; anything smaller was invisible.
// `logEnrichedPromptSize` now emits the final byte size once per build,
// suppressed under vitest so test runs stay clean.
// ──────────────────────────────────────────────────────────────────

import { logEnrichedPromptSize } from './chat.js';

describe('logEnrichedPromptSize', () => {
  const originalNodeEnv = process.env.NODE_ENV;
  const originalForce = process.env.PROMPT_SIZE_LOG_FORCE;

  beforeEach(() => {
    process.env.NODE_ENV = 'test';
    delete process.env.PROMPT_SIZE_LOG_FORCE;
  });

  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv;
    if (originalForce === undefined) {
      delete process.env.PROMPT_SIZE_LOG_FORCE;
    } else {
      process.env.PROMPT_SIZE_LOG_FORCE = originalForce;
    }
  });

  it('returns the UTF-8 byte length (not character count) of the prompt', () => {
    // 'é' is two bytes in UTF-8; the byte count must reflect that.
    const prompt = 'hello é';
    expect(prompt.length).toBe(7);
    expect(logEnrichedPromptSize(prompt, 'agent-x', false, null)).toBe(8);
  });

  it('stays silent under NODE_ENV=test by default', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      logEnrichedPromptSize('hello world', 'agent-x', true, 'sess-1');
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it('emits one structured line when PROMPT_SIZE_LOG_FORCE=1', () => {
    process.env.PROMPT_SIZE_LOG_FORCE = '1';
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const bytes = logEnrichedPromptSize('hello world', 'hub-lead', true, 'sess-1');
      expect(bytes).toBe(11);
      expect(spy).toHaveBeenCalledTimes(1);
      const line = spy.mock.calls[0][0] as string;
      expect(line).toContain('[enriched-prompt]');
      expect(line).toContain('bytes=11');
      expect(line).toContain('agent=hub-lead');
      expect(line).toContain('firstMessage=true');
      expect(line).toContain('session=sess-1');
    } finally {
      spy.mockRestore();
    }
  });

  it('omits the session= suffix when sessionId is null', () => {
    process.env.PROMPT_SIZE_LOG_FORCE = '1';
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      logEnrichedPromptSize('xx', 'a', false, null);
      const line = spy.mock.calls[0][0] as string;
      expect(line).not.toContain('session=');
      expect(line).toContain('firstMessage=false');
    } finally {
      spy.mockRestore();
    }
  });

  it('emits a log when NODE_ENV is not "test" (e.g. production)', () => {
    process.env.NODE_ENV = 'production';
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      logEnrichedPromptSize('hello', 'a', true, null);
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });
});

describe('buildEnrichedPrompt — wiki context cap', () => {
  beforeEach(() => {
    mkdirSync(tmpBase, { recursive: true });
    mkdirSync(path.join(tmpBase, 'skills'), { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpBase, { recursive: true, force: true });
  });

  it('still injects the wiki section header when the mocked context returns one', () => {
    // The module-level mock (`vi.mock('./wiki.js', ...)`) returns a two-page
    // fixture for any non-empty projectId. This regression guards against
    // accidentally dropping the wiki block entirely when refactoring the
    // cap logic — the header must still appear in the enriched prompt.
    const prompt = buildEnrichedPrompt(makeProject(), makeAgent(), {
      isFirstMessage: true,
    });
    expect(prompt).toContain('## Project Wiki (2 pages)');
  });
});
