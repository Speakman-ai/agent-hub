import { describe, expect, it, vi } from 'vitest';
import type { Project } from './types.js';
import {
  autopilotMainlineStartEnabled,
  checkMainlineAutopilotTarget,
  findMainlineEnvironmentOwner,
} from './session-autopilot-mainline-start.js';

const project = { id: 'proj', name: 'proj', cwd: '/tmp/proj', gitHost: 'agenthub' } as Project;

const DEPLOY_YAML = `version: 1
environments:
  staging:
    steps:
      - run: echo deploy
  production:
    steps:
      - run: echo deploy
`;

function deps(overrides: Parameters<typeof checkMainlineAutopilotTarget>[2] = {}) {
  return {
    sessionDefaultBranch: async () => 'main',
    readDeployYaml: vi.fn(async () => 'raw'),
    parseEnvironmentNames: () => ['staging', 'production'],
    isDeployable: () => true,
    ...overrides,
  };
}

describe('checkMainlineAutopilotTarget', () => {
  it('reads deploy.yaml at the default branch and accepts a declared, unpaused env', async () => {
    const d = deps();
    const res = await checkMainlineAutopilotTarget(project, ' staging ', d);
    expect(res).toEqual({
      ok: true,
      defaultBranch: 'main',
      declaredEnvironments: ['staging', 'production'],
    });
    expect(d.readDeployYaml).toHaveBeenCalledWith(project, 'main');
  });

  it('parses a real deploy.yaml when no parser is injected', async () => {
    const res = await checkMainlineAutopilotTarget(project, 'qa', {
      ...deps(),
      parseEnvironmentNames: undefined,
      readDeployYaml: async () => DEPLOY_YAML,
    });
    expect(res).toMatchObject({
      ok: false,
      error: 'autopilot_deploy_env_unknown',
      declaredEnvironments: ['staging', 'production'],
    });
    if (!res.ok) expect(res.message).toContain('Declared: "staging", "production"');
  });

  it('falls back to the hosted repo HEAD when the session has no worktree', async () => {
    const d = deps({
      sessionDefaultBranch: async () => null,
      hostedDefaultBranch: async () => 'trunk',
    });
    const res = await checkMainlineAutopilotTarget(project, 'staging', d);
    expect(res).toMatchObject({ ok: true, defaultBranch: 'trunk' });
    expect(d.readDeployYaml).toHaveBeenCalledWith(project, 'trunk');
  });

  it('refuses when the default branch cannot be resolved', async () => {
    const res = await checkMainlineAutopilotTarget(
      { ...project, gitHost: undefined, cwd: '' } as Project,
      'staging',
      deps({ sessionDefaultBranch: async () => null }),
    );
    expect(res).toMatchObject({ ok: false, error: 'autopilot_default_branch_unknown' });
  });

  it('refuses when deploy.yaml is missing on the default branch', async () => {
    const res = await checkMainlineAutopilotTarget(
      project,
      'staging',
      deps({ readDeployYaml: async () => null }),
    );
    expect(res).toMatchObject({ ok: false, error: 'autopilot_deploy_config_missing' });
    if (!res.ok) expect(res.message).toContain("'main'");
  });

  it('refuses an invalid deploy.yaml', async () => {
    const res = await checkMainlineAutopilotTarget(project, 'staging', {
      ...deps(),
      parseEnvironmentNames: undefined,
      readDeployYaml: async () => 'environments: 3',
    });
    expect(res).toMatchObject({ ok: false, error: 'autopilot_deploy_config_invalid' });
  });

  it('refuses a paused environment and lists the declared ones', async () => {
    const res = await checkMainlineAutopilotTarget(
      project,
      'production',
      deps({ isDeployable: () => false }),
    );
    expect(res).toMatchObject({
      ok: false,
      error: 'autopilot_deploy_env_paused',
      declaredEnvironments: ['staging', 'production'],
    });
    if (!res.ok) expect(res.message).toContain('paused');
  });
});

function row(id: string, cfg: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return {
    id,
    agent_id: 'agent-1',
    session_mode: 'autopilot',
    deleted_at: null,
    autopilot_session_config: JSON.stringify({
      durationHours: 1,
      brief: 'b',
      goal: 'g',
      escalation: 'none',
      branch: 'main',
      startedAt: '2026-09-27T10:00:00.000Z',
      status: 'running',
      target: 'mainline',
      mainline: { deployEnvironment: 'staging', slot: { phase: 'idle' } },
      ...cfg,
    }),
    ...extra,
  };
}

describe('findMainlineEnvironmentOwner', () => {
  const base = {
    projectOf: (agentId: string) => (agentId === 'agent-1' ? 'proj' : 'other'),
    projectId: 'proj',
    environment: 'staging',
    excludeSessionId: 'me',
  };

  it('finds a running session on the same project and environment', () => {
    expect(findMainlineEnvironmentOwner({ ...base, candidates: [row('s2', {})] })).toEqual({
      sessionId: 's2',
      reason: 'running',
    });
  });

  it('ignores this session, other projects, other envs, and branch-target rows', () => {
    const candidates = [
      row('me', {}),
      row('s3', {}, { agent_id: 'agent-9' }),
      row('s4', { mainline: { deployEnvironment: 'production', slot: { phase: 'idle' } } }),
      row('s5', { target: 'branch', mainline: undefined, branch: 'feat/x' }),
    ];
    expect(findMainlineEnvironmentOwner({ ...base, candidates })).toBeNull();
  });

  it('releases the environment once the run stops with an idle slot', () => {
    const candidates = [
      row('s2', { status: 'completed' }),
      row('s3', {}, { session_mode: 'chat' }),
      row('s4', {}, { deleted_at: '2026-09-27 11:00:00' }),
    ];
    expect(findMainlineEnvironmentOwner({ ...base, candidates })).toBeNull();
  });

  it('keeps ownership while a stopped session still owes a landing', () => {
    const candidates = [
      row(
        's2',
        {
          status: 'expired',
          mainline: {
            deployEnvironment: 'staging',
            slot: { phase: 'uncertain', attemptId: 'a1', sha: 'abcdef1234567' },
          },
        },
        { session_mode: 'chat' },
      ),
    ];
    expect(findMainlineEnvironmentOwner({ ...base, candidates })).toEqual({
      sessionId: 's2',
      reason: 'owes_landing',
    });
  });
});

describe('autopilotMainlineStartEnabled', () => {
  it('is on by default and off only with the explicit opt-out', () => {
    expect(autopilotMainlineStartEnabled({})).toBe(true);
    expect(autopilotMainlineStartEnabled({ AGENT_HUB_AUTOPILOT_MAINLINE: '' })).toBe(true);
    expect(autopilotMainlineStartEnabled({ AGENT_HUB_AUTOPILOT_MAINLINE: '1' })).toBe(true);
    expect(autopilotMainlineStartEnabled({ AGENT_HUB_AUTOPILOT_MAINLINE: 'false' })).toBe(true);
    expect(autopilotMainlineStartEnabled({ AGENT_HUB_AUTOPILOT_MAINLINE: '0' })).toBe(false);
  });
});
