/**
 * No Guardrails session mode: project gate, session predicate, and the prompt
 * contract (the "No Direct Ship" block is dropped, the override preamble added).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { existsSync, mkdirSync } from 'fs';
import path from 'path';
import os from 'os';
import type { EnrichedAgent } from './types.js';

const tmpBase = path.join(os.tmpdir(), `no-guardrails-prompt-test-${Date.now()}`);

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

import { buildEnrichedPrompt } from './chat.js';
import {
  buildNoGuardrailsPreamble,
  isNoGuardrailsModeActive,
  noGuardrailsEnabledForProject,
  sessionRunsWithoutGuardrails,
} from './no-guardrails.js';
import { validateSessionModeForProject } from './project-mode-guards.js';
import { isShippingCompatibleSessionMode } from './session-mode.js';

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

const project = (overrides: Record<string, unknown> = {}) =>
  ({ id: 'p', name: 'P', cwd: tmpBase, ahw: tmpBase, agents: [], ...overrides }) as never;

describe('No Guardrails gate', () => {
  it('is off unless the project explicitly enables it', () => {
    expect(noGuardrailsEnabledForProject(null)).toBe(false);
    expect(noGuardrailsEnabledForProject(project())).toBe(false);
    expect(noGuardrailsEnabledForProject(project({ noGuardrails: { enabled: false } }))).toBe(
      false,
    );
    expect(noGuardrailsEnabledForProject(project({ noGuardrails: { enabled: true } }))).toBe(true);
    expect(
      noGuardrailsEnabledForProject(project({ mode: 'workflow', noGuardrails: { enabled: true } })),
    ).toBe(false);
  });

  it('needs both the session mode and the project toggle', () => {
    const on = project({ noGuardrails: { enabled: true } });
    const session = { session_mode: 'no-guardrails' };
    expect(isNoGuardrailsModeActive(session)).toBe(true);
    expect(sessionRunsWithoutGuardrails(on, session)).toBe(true);
    expect(sessionRunsWithoutGuardrails(project(), session)).toBe(false);
    expect(sessionRunsWithoutGuardrails(on, { session_mode: 'chat' })).toBe(false);
  });

  it('validates the mode against the project toggle', () => {
    expect(validateSessionModeForProject(project() as never, 'no-guardrails')?.error).toBe(
      'no_guardrails_not_enabled',
    );
    expect(
      validateSessionModeForProject(project({ noGuardrails: { enabled: true } }), 'no-guardrails'),
    ).toBeNull();
    expect(
      validateSessionModeForProject(
        project({ mode: 'workflow', noGuardrails: { enabled: true } }),
        'no-guardrails',
      )?.error,
    ).toBe('session_mode_not_allowed_on_workflow_project');
  });

  it('keeps Finalize available (shipping-compatible mode)', () => {
    expect(isShippingCompatibleSessionMode('no-guardrails')).toBe(true);
  });
});

describe('No Guardrails prompt contract', () => {
  const agent = { id: 'a', name: 'A', engine: 'claude-code', systemPrompt: 'x', role: 'dev' };
  const hosted = project({ gitHost: 'agenthub' });

  it('keeps the No Direct Ship block for a normal session', () => {
    const prompt = buildEnrichedPrompt(hosted, agent as never, { isFirstMessage: true });
    expect(prompt).toContain('No Direct Ship');
  });

  it('drops the No Direct Ship block when noGuardrails is set', () => {
    const prompt = buildEnrichedPrompt(hosted, agent as never, {
      isFirstMessage: true,
      noGuardrails: true,
    });
    expect(prompt).not.toContain('No Direct Ship');
  });

  it('preamble overrides the ship rules and names the branch', () => {
    const preamble = buildNoGuardrailsPreamble({ branch: 'b1', pushTargetLabel: 'Agent Hub' });
    expect(preamble).toContain('## No Guardrails Session');
    expect(preamble).toContain('overrides');
    expect(preamble).toContain('`git push`');
    expect(preamble).toContain('`b1`');
  });
});
