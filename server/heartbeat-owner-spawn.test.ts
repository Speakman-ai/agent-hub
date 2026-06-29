import { beforeEach, describe, expect, it, vi } from 'vitest';
import os from 'os';
import type { Agent, EnrichedAgent, Project } from './types.js';

const mockProjectState = vi.hoisted(() => ({
  projects: [] as Project[],
  saveProjects: vi.fn(),
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

const { resolveOneShotEngine } = await import('./engine-resolver.js');
const { mergeSkillCredentialSpawnEnv } = await import('./skill-credentials-spawn.js');
const { runHeartbeat } = await import('./heartbeat.js');
const { resetHeartbeatOwnerBackfillForTests } = await import('./heartbeat-ownership.js');

describe('runHeartbeat owner spawn identity', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetHeartbeatOwnerBackfillForTests();
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

  it('uses heartbeat.owner_user_id for engine resolution and skill credentials', async () => {
    const agent: EnrichedAgent = {
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
    };

    await runHeartbeat(agent);

    expect(resolveOneShotEngine).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ userId: 'user-a' }),
    );
    expect(mergeSkillCredentialSpawnEnv).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ ownerId: 'user-a', agentId: 'agent-1' }),
    );
  });

  it('backfills legacy heartbeat owners before engine resolution', async () => {
    const persistedAgent: Agent = {
      id: 'agent-legacy',
      name: 'Legacy Agent',
      engine: 'claude-code',
      color: '#888',
      systemPrompt: 'system',
      heartbeat: {
        enabled: true,
        interval: '0 * * * *',
        prompt: 'check in',
        shared: 0,
      },
    };
    mockProjectState.projects = [
      {
        id: 'proj',
        name: 'Project',
        cwd: os.tmpdir(),
        agents: [persistedAgent],
        ahw: `${os.tmpdir()}/ahw`,
      } as Project,
    ];
    const agent: EnrichedAgent = {
      ...persistedAgent,
      heartbeat: {
        enabled: true,
        interval: '0 * * * *',
        prompt: 'check in',
        shared: 0,
      },
      projectId: 'proj',
      projectName: 'Project',
      cwd: os.tmpdir(),
      ahw: `${os.tmpdir()}/ahw`,
      workspace: os.tmpdir(),
    };

    await runHeartbeat(agent);

    expect(persistedAgent.heartbeat?.owner_user_id).toBe('owner-a');
    expect(agent.heartbeat?.owner_user_id).toBe('owner-a');
    expect(mockProjectState.saveProjects).toHaveBeenCalled();
    expect(resolveOneShotEngine).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ userId: 'owner-a' }),
    );
    expect(mergeSkillCredentialSpawnEnv).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ ownerId: 'owner-a', agentId: 'agent-legacy' }),
    );
  });

  it('backfills ownerless heartbeats discovered after an earlier scan', async () => {
    const firstAgent: EnrichedAgent = {
      id: 'agent-owned',
      name: 'Owned Agent',
      engine: 'claude-code',
      color: '#888',
      systemPrompt: 'system',
      heartbeat: {
        enabled: true,
        interval: '0 * * * *',
        prompt: 'check in',
        owner_user_id: 'user-a',
        shared: 0,
      },
      projectId: 'proj',
      projectName: 'Project',
      cwd: os.tmpdir(),
      ahw: `${os.tmpdir()}/ahw`,
      workspace: os.tmpdir(),
    };
    await runHeartbeat(firstAgent);

    vi.clearAllMocks();
    const latePersistedAgent: Agent = {
      id: 'agent-late',
      name: 'Late Agent',
      engine: 'claude-code',
      color: '#888',
      systemPrompt: 'system',
      heartbeat: {
        enabled: true,
        interval: '0 * * * *',
        prompt: 'late check in',
        shared: 0,
      },
    };
    mockProjectState.projects = [
      {
        id: 'proj',
        name: 'Project',
        cwd: os.tmpdir(),
        agents: [latePersistedAgent],
        ahw: `${os.tmpdir()}/ahw`,
      } as Project,
    ];
    const lateAgent: EnrichedAgent = {
      ...latePersistedAgent,
      heartbeat: {
        enabled: true,
        interval: '0 * * * *',
        prompt: 'late check in',
        shared: 0,
      },
      projectId: 'proj',
      projectName: 'Project',
      cwd: os.tmpdir(),
      ahw: `${os.tmpdir()}/ahw`,
      workspace: os.tmpdir(),
    };

    await runHeartbeat(lateAgent);

    expect(latePersistedAgent.heartbeat?.owner_user_id).toBe('owner-a');
    expect(lateAgent.heartbeat?.owner_user_id).toBe('owner-a');
    expect(resolveOneShotEngine).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ userId: 'owner-a' }),
    );
  });
});
