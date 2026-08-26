import { vi, describe, it, expect, beforeEach } from 'vitest';
import type { Project } from './types.js';
import type { ParsedOptions } from './skill-options-declaration.js';

// Mock the runtime skill list + schema resolver + selection store so we can
// drive exactly which options resolve and what the user selected.
vi.mock('./agent-skills-list.js', () => ({
  listEnabledSkills: vi.fn(() => [
    { id: 'survey-tracker', name: 'survey-tracker', description: '' },
  ]),
}));
vi.mock('./skill-options-resolve.js', () => ({
  readOptionsSchemaForSkill: vi.fn(),
}));
vi.mock('./skill-options-store.js', () => ({
  getUserSkillOptionValues: vi.fn(() => new Map<string, string>()),
}));

const { readOptionsSchemaForSkill } = await import('./skill-options-resolve.js');
const { getUserSkillOptionValues } = await import('./skill-options-store.js');
const { mergeSkillOptionSpawnEnv } = await import('./skill-options-spawn.js');

const SCHEMA: ParsedOptions = {
  error: null,
  options: [
    {
      name: 'SURVEY_TRACKER_ENV',
      label: 'Environment',
      description: '',
      choices: [
        { value: 'dev', label: 'Development' },
        { value: 'prod', label: 'Production' },
      ],
      default: 'dev',
      required: false,
    },
  ],
};

function makeProject(agents: unknown[]): Project {
  return {
    id: 'p1',
    name: 'P',
    cwd: '/tmp',
    ahw: '/tmp/ahw',
    color: '#000',
    agents,
  } as unknown as Project;
}

const AGENT = [{ id: 'a1', name: 'A1', engine: 'claude-code' }];

describe('mergeSkillOptionSpawnEnv', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(readOptionsSchemaForSkill).mockReturnValue(SCHEMA);
    vi.mocked(getUserSkillOptionValues).mockReturnValue(new Map());
  });

  it('injects the user selection when it is a legal choice', () => {
    vi.mocked(getUserSkillOptionValues).mockReturnValue(new Map([['SURVEY_TRACKER_ENV', 'prod']]));
    const env: NodeJS.ProcessEnv = {};
    mergeSkillOptionSpawnEnv(env, { ownerId: 'u1', agentId: 'a1', project: makeProject(AGENT) });
    expect(env.SURVEY_TRACKER_ENV).toBe('prod');
  });

  it('falls back to the default when no selection is stored', () => {
    const env: NodeJS.ProcessEnv = {};
    mergeSkillOptionSpawnEnv(env, { ownerId: 'u1', agentId: 'a1', project: makeProject(AGENT) });
    expect(env.SURVEY_TRACKER_ENV).toBe('dev');
  });

  it('falls back to the default when the stored selection is not a legal choice', () => {
    vi.mocked(getUserSkillOptionValues).mockReturnValue(
      new Map([['SURVEY_TRACKER_ENV', 'staging']]),
    );
    const env: NodeJS.ProcessEnv = {};
    mergeSkillOptionSpawnEnv(env, { ownerId: 'u1', agentId: 'a1', project: makeProject(AGENT) });
    expect(env.SURVEY_TRACKER_ENV).toBe('dev');
  });

  it('never overwrites an env var already set to a non-empty value', () => {
    vi.mocked(getUserSkillOptionValues).mockReturnValue(new Map([['SURVEY_TRACKER_ENV', 'prod']]));
    const env: NodeJS.ProcessEnv = { SURVEY_TRACKER_ENV: 'preset' };
    mergeSkillOptionSpawnEnv(env, { ownerId: 'u1', agentId: 'a1', project: makeProject(AGENT) });
    expect(env.SURVEY_TRACKER_ENV).toBe('preset');
  });

  it('injects nothing when the schema is malformed', () => {
    vi.mocked(readOptionsSchemaForSkill).mockReturnValue({ error: 'bad', options: [] });
    const env: NodeJS.ProcessEnv = {};
    mergeSkillOptionSpawnEnv(env, { ownerId: 'u1', agentId: 'a1', project: makeProject(AGENT) });
    expect(env.SURVEY_TRACKER_ENV).toBeUndefined();
  });

  it('injects nothing when there is no owner', () => {
    const env: NodeJS.ProcessEnv = {};
    mergeSkillOptionSpawnEnv(env, { ownerId: null, agentId: 'a1', project: makeProject(AGENT) });
    expect(env.SURVEY_TRACKER_ENV).toBeUndefined();
    expect(readOptionsSchemaForSkill).not.toHaveBeenCalled();
  });
});
