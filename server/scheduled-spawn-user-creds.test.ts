import { beforeEach, describe, expect, it, vi } from 'vitest';
import os from 'os';
import type { EnrichedAgent, Project } from './types.js';

/**
 * Regression coverage for: "Crons/heartbeats don't inject the owner's stored
 * AI credentials" (the CLI reports it needs to log in on scheduled runs).
 *
 * The cron and heartbeat spawn paths build their env with `buildSpawnEnv` but
 * historically passed only `{ userId }` and never `userOverride`. Because
 * `buildSpawnEnv` injects per-account engine keys ONLY from `userOverride`
 * (no host fallback for claude/cursor/codex/grok), the spawned CLI ran
 * logged-out for users whose credentials live in the Hub DB. These tests pin
 * that the owner's stored creds now reach the spawn env.
 */

const mockProjectState = vi.hoisted(() => ({
  projects: [] as Project[],
  saveProjects: vi.fn(),
}));

const mockUserAuth = vi.hoisted(() => ({
  claude: {} as Record<
    string,
    { anthropicApiKey: string | null; claudeCodeOAuthToken: string | null }
  >,
}));

vi.mock('./worktree.js', () => ({
  getOrCreateProcessWorktree: vi.fn(async (cwd: string) => cwd),
}));

vi.mock('./project-model.js', () => ({
  getProjects: vi.fn(() => mockProjectState.projects),
  saveProjects: mockProjectState.saveProjects,
}));

vi.mock('./orgs.js', () => ({
  getActiveOrgId: vi.fn(() => 'default'),
}));

vi.mock('./memberships-store.js', () => ({
  listMembersForOrg: vi.fn(() => [
    { userId: 'owner-a', username: 'owner@example.com', role: 'Owner', createdAt: '1' },
  ]),
}));

vi.mock('./engine-resolver.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./engine-resolver.js')>();
  return {
    ...actual,
    resolveOneShotEngine: vi.fn(async () => ({
      engine: 'claude-code',
      model: 'claude-opus-4-8',
      fallbackUsed: false,
    })),
  };
});

vi.mock('./one-shot-spawn.js', () => ({
  runOneShotPrompt: vi.fn(async () => 'ok'),
}));

vi.mock('./skill-credentials-spawn.js', () => ({
  mergeSkillCredentialSpawnEnv: vi.fn(),
}));

vi.mock('./project-secrets-spawn.js', () => ({
  mergeProjectSecretsSpawnEnv: vi.fn(),
}));

vi.mock('./project-aws-spawn.js', () => ({
  mergeProjectAwsSpawnEnv: vi.fn(),
}));

vi.mock('./users-store.js', () => ({
  getUserClaudeAuth: vi.fn((userId: string) => mockUserAuth.claude[userId] ?? null),
  getUserCursorAuth: vi.fn(() => null),
  getUserGeminiAuth: vi.fn(() => null),
  getUserCodexAuth: vi.fn(() => null),
  getUserGrokAuth: vi.fn(() => null),
}));

const { runOneShotPrompt } = await import('./one-shot-spawn.js');
const { runHeartbeat } = await import('./heartbeat.js');
const { resolveUserCliCredOverride } = await import('./per-user-cli-spawn.js');
const { resetHeartbeatOwnerBackfillForTests } = await import('./heartbeat-ownership.js');

describe('resolveUserCliCredOverride', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUserAuth.claude = {};
  });

  it('returns null for a missing/empty user', () => {
    expect(resolveUserCliCredOverride(null)).toBeNull();
    expect(resolveUserCliCredOverride('   ')).toBeNull();
  });

  it('returns null when the user has no stored keys', () => {
    mockUserAuth.claude['user-empty'] = { anthropicApiKey: null, claudeCodeOAuthToken: null };
    expect(resolveUserCliCredOverride('user-empty')).toBeNull();
  });

  it('builds an override from the user stored Claude api key', () => {
    mockUserAuth.claude['user-a'] = {
      anthropicApiKey: 'sk-ant-user-a',
      claudeCodeOAuthToken: null,
    };
    expect(resolveUserCliCredOverride('user-a')).toMatchObject({
      anthropicApiKey: 'sk-ant-user-a',
      claudeCodeOAuthToken: null,
    });
  });
});

describe('runHeartbeat injects the owner stored AI credentials', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetHeartbeatOwnerBackfillForTests();
    mockUserAuth.claude = {};
    mockProjectState.projects = [
      {
        id: 'proj',
        name: 'Project',
        cwd: os.tmpdir(),
        agents: [],
        ahw: `${os.tmpdir()}/ahw`,
      } as Project,
    ];
  });

  function makeAgent(): EnrichedAgent {
    return {
      id: 'agent-1',
      name: 'Agent',
      engine: 'claude-code',
      color: '#888',
      systemPrompt: 'system',
      heartbeat: {
        enabled: true,
        interval: '0 * * * *',
        prompt: 'check in',
        owner_user_id: 'user-a',
        shared: 1,
      },
      projectId: 'proj',
      projectName: 'Project',
      cwd: os.tmpdir(),
      ahw: `${os.tmpdir()}/ahw`,
      workspace: os.tmpdir(),
    } as EnrichedAgent;
  }

  it("passes the owner's ANTHROPIC_API_KEY into the spawn env", async () => {
    mockUserAuth.claude['user-a'] = {
      anthropicApiKey: 'sk-ant-user-a',
      claudeCodeOAuthToken: null,
    };

    await runHeartbeat(makeAgent());

    expect(runOneShotPrompt).toHaveBeenCalledTimes(1);
    const spawnArgs = vi.mocked(runOneShotPrompt).mock.calls[0]![0];
    expect(spawnArgs.env?.ANTHROPIC_API_KEY).toBe('sk-ant-user-a');
  });

  it('does not set ANTHROPIC_API_KEY when the owner has no stored creds', async () => {
    await runHeartbeat(makeAgent());

    expect(runOneShotPrompt).toHaveBeenCalledTimes(1);
    const spawnArgs = vi.mocked(runOneShotPrompt).mock.calls[0]![0];
    expect(spawnArgs.env?.ANTHROPIC_API_KEY).toBeUndefined();
  });
});
