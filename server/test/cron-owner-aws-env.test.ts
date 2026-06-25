import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';
import type { AuthenticatedRequest } from '../auth.js';
import type { CronRow } from '../types.js';

vi.mock('../engine-resolver.js', () => {
  class NoEnginesAvailableError extends Error {}
  return {
    NoEnginesAvailableError,
    resolveOneShotEngine: vi.fn(async () => ({
      engine: 'gemini-cli',
      model: 'gemini-test',
      fallbackUsed: false,
      fallbackFromReason: null,
    })),
  };
});

vi.mock('../git-host/repo-store.js', () => ({
  hostedBarePathForProject: vi.fn(() => null),
}));

vi.mock('../one-shot-spawn.js', () => ({
  runOneShotPrompt: vi.fn(async () => ({
    stdout: 'cron ok',
    stderr: '',
    code: 0,
    timedOut: false,
  })),
}));

vi.mock('../worktree.js', () => ({
  getOrCreateProcessWorktree: vi.fn(async (cwd: string) => cwd),
}));

const { getStmts } = await import('../db.js');
const { default: createCronRoutes } = await import('../routes/crons.js');
const { runCronJob } = await import('../heartbeat.js');
const { runOneShotPrompt } = await import('../one-shot-spawn.js');
const { findProject, saveProjects } = await import('../project-model.js');
const { createAgent, createProject } = await import('./helpers.js');

function cronRoutesApp(userId: string | null): express.Express {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    if (userId) {
      (req as AuthenticatedRequest).authUserId = userId;
    }
    next();
  });
  app.use(createCronRoutes({ stmts: getStmts() } as Parameters<typeof createCronRoutes>[0]));
  return app;
}

describe('cron owner AWS spawn env', () => {
  beforeEach(() => {
    (runOneShotPrompt as Mock).mockClear();
  });

  it('stores the creator user id and runs with that user HOME plus project AWS files', async () => {
    const ownerUserId = 'cron-owner-user';
    const project = await createProject();
    const projectId = project.id as string;
    const storedProject = findProject(projectId) as
      | (NonNullable<ReturnType<typeof findProject>> & {
          awsSsoProfiles?: Record<string, Record<string, string>>;
        })
      | undefined;
    expect(storedProject).toBeTruthy();
    storedProject!.awsSsoProfiles = {
      dev: {
        type: 'sso',
        sso_start_url: 'https://example.awsapps.com/start',
        sso_region: 'us-east-1',
        sso_account_id: '111111111111',
        sso_role_name: 'Admin',
        region: 'us-east-1',
      },
    };
    saveProjects();
    await createAgent({ projectId, id: `${projectId}-a` });
    await createAgent({ projectId, id: `${projectId}-b` });

    const res = await request(cronRoutesApp(ownerUserId))
      .post('/api/crons')
      .send({
        name: `Creator AWS ${Math.random().toString(36).slice(2, 8)}`,
        schedule: '0 * * * *',
        prompt: 'whoami',
        cwd: '/tmp',
        enabled: false,
        project_id: projectId,
      })
      .expect(200);

    const cron = res.body as CronRow;
    expect(cron.owner_user_id).toBe(ownerUserId);
    expect(cron.skill_principal_agent_id).toBeNull();

    await runCronJob(cron);

    expect(runOneShotPrompt).toHaveBeenCalledTimes(1);
    const input = (runOneShotPrompt as Mock).mock.calls[0][0] as {
      env: NodeJS.ProcessEnv;
    };
    expect(input.env.HOME).toContain(`per-user-creds/${ownerUserId}/home`);
    expect(input.env.AWS_CONFIG_FILE).toContain(`project-aws-config/${projectId}/config`);
    expect(input.env.AWS_SHARED_CREDENTIALS_FILE).toContain(
      `project-aws-config/${projectId}/credentials`,
    );
    expect(input.env.AGENT_HUB_AWS_PROFILE_NAMES).toBe('dev');
  });

  it('keeps legacy ownerless crons on the host HOME fallback', async () => {
    const res = await request(cronRoutesApp(null))
      .post('/api/crons')
      .send({
        name: `Legacy Host ${Math.random().toString(36).slice(2, 8)}`,
        schedule: '0 * * * *',
        prompt: 'whoami',
        cwd: '/tmp',
        enabled: false,
      })
      .expect(200);

    const cron = res.body as CronRow;
    expect(cron.owner_user_id).toBeNull();

    await runCronJob(cron);

    const input = (runOneShotPrompt as Mock).mock.calls[0][0] as {
      env: NodeJS.ProcessEnv;
    };
    expect(input.env.HOME).toContain('host-creds/home');
  });
});
