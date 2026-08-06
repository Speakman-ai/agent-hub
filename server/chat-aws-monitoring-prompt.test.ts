/**
 * The monitoring designation has to reach a spawned session, not just the
 * settings API. `buildEnrichedPrompt` is the runtime path that consumes
 * `getProjectAwsMonitoringProfile`: an unattended spawn (heartbeat, cron,
 * autonomous dispatch) has no human to click "SSO login" in the AWS settings
 * module, so the prompt names the one profile that authenticates without one.
 *
 * Deliberately NOT covered here: exporting the designation as `AWS_PROFILE`.
 * That variable answers "which account does a human mean when they omit
 * --profile", which is exactly the overload `awsMonitoringProfile` exists to
 * avoid — see the guard in `project-aws-spawn.test.ts`.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, existsSync } from 'fs';
import path from 'path';
import os from 'os';
import type { EnrichedAgent, Project } from './types.js';

const tmpBase = path.join(os.tmpdir(), `aws-monitoring-prompt-test-${Date.now()}`);

const { mockFindProject } = vi.hoisted(() => ({
  mockFindProject: vi.fn((_id: string): Project | null => null),
}));

vi.mock('./db.js', () => ({
  db: {},
  stmts: { getAgentSkillOverrides: { all: () => [] } },
}));

vi.mock('./wiki.js', () => ({ getWikiContext: () => '' }));

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
  resolveProjectPaths: () => ({ skillsDir: path.join(tmpBase, 'skills'), contextFiles: {} }),
  contextFilePath: (_paths: unknown, filename: string) => {
    const p = path.join(tmpBase, filename);
    return existsSync(p) ? p : null;
  },
}));

vi.mock('./project-model.js', () => ({
  allAgents: () => [],
  findProject: (id: string) => mockFindProject(id),
}));

import { buildEnrichedPrompt } from './chat.js';

const SSO = {
  type: 'sso' as const,
  sso_account_id: '120569607241',
  sso_start_url: 'https://example.awsapps.com/start/',
  sso_region: 'us-east-2',
  sso_role_name: 'AdministratorAccess',
  region: 'us-east-2',
};

const ROLE = {
  type: 'role' as const,
  role_arn: 'arn:aws:iam::120569607241:role/AgentHubMonitoring',
  region: 'us-east-2',
};

function projectWithAws(overrides: Record<string, unknown>): Project {
  return {
    id: 'proj-a',
    name: 'Project A',
    cwd: tmpBase,
    ahw: tmpBase,
    agents: [],
    ...overrides,
  } as unknown as Project;
}

function agent(): EnrichedAgent {
  return {
    id: 'alice',
    name: 'Alice',
    engine: 'claude-code',
    projectId: 'proj-a',
    projectName: 'Project A',
    cwd: tmpBase,
    ahw: tmpBase,
    workspace: tmpBase,
    systemPrompt: 'You are Alice.',
  } as unknown as EnrichedAgent;
}

describe('buildEnrichedPrompt — AWS monitoring designation', () => {
  beforeEach(() => {
    mkdirSync(tmpBase, { recursive: true });
    mockFindProject.mockReset();
  });

  afterEach(() => {
    rmSync(tmpBase, { recursive: true, force: true });
  });

  it('carries the designated monitoring profile into a spawned prompt', () => {
    mockFindProject.mockImplementation(() =>
      projectWithAws({
        awsSsoProfiles: { dev: SSO, monitoring: ROLE },
        awsMonitoringProfile: 'monitoring',
      }),
    );

    const prompt = buildEnrichedPrompt(agent());

    expect(prompt).toContain('## Project AWS');
    expect(prompt).toMatch(/--profile monitoring/);
    expect(prompt).toMatch(/heartbeat, cron, autonomous dispatch/i);
  });

  it('says nothing about unattended runs when no profile is designated', () => {
    mockFindProject.mockImplementation(() =>
      projectWithAws({ awsSsoProfiles: { dev: SSO, monitoring: ROLE } }),
    );

    const prompt = buildEnrichedPrompt(agent());

    expect(prompt).toContain('## Project AWS');
    expect(prompt).not.toMatch(/Unattended runs/i);
  });

  // A designation that stopped naming a live non-SSO profile must not be
  // advertised: the prompt would be sending unattended sessions at credentials
  // that cannot authenticate. Same resolve-don't-trust rule as the REST
  // envelope's `effectiveMonitoringProfile`.
  it('drops a designation whose profile was deleted', () => {
    mockFindProject.mockImplementation(() =>
      projectWithAws({ awsSsoProfiles: { dev: SSO }, awsMonitoringProfile: 'monitoring' }),
    );

    const prompt = buildEnrichedPrompt(agent());

    expect(prompt).not.toMatch(/Unattended runs/i);
    expect(prompt).not.toMatch(/--profile monitoring/);
  });

  it('drops a designation whose profile became SSO', () => {
    mockFindProject.mockImplementation(() =>
      projectWithAws({
        awsSsoProfiles: { monitoring: SSO },
        awsMonitoringProfile: 'monitoring',
      }),
    );

    const prompt = buildEnrichedPrompt(agent());

    expect(prompt).not.toMatch(/Unattended runs/i);
  });

  it('adds no AWS section at all for a project with no profiles', () => {
    mockFindProject.mockImplementation(() => projectWithAws({}));

    expect(buildEnrichedPrompt(agent())).not.toContain('## Project AWS');
  });
});
