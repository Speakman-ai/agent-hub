import { describe, expect, it } from 'vitest';
import express from 'express';
import request from 'supertest';
import {
  applyAutopilotWorkerSpawnEnv,
  autopilotWorkerGuard,
  autopilotWorkerKeyName,
  decideAutopilotWorkerRequest,
  isAutopilotWorkerKeyName,
  parseAutopilotWorkerKeyName,
} from './worker-authority.js';

const SCOPE = { projectId: 'demo-app', runId: 'run-1' };

describe('autopilot worker key names', () => {
  it('round-trips project and run ids', () => {
    const name = autopilotWorkerKeyName('demo-app', 'run-1');
    expect(isAutopilotWorkerKeyName(name)).toBe(true);
    expect(parseAutopilotWorkerKeyName(name)).toEqual(SCOPE);
    expect(parseAutopilotWorkerKeyName('spawn:sess-1')).toBeNull();
    expect(parseAutopilotWorkerKeyName('autopilot:only-one-part')).toBeNull();
  });
});

describe('decideAutopilotWorkerRequest', () => {
  it('rejects other projects', () => {
    const denied = decideAutopilotWorkerRequest(SCOPE, 'GET', '/api/projects/other-app/wiki/pages');
    expect(denied).toEqual({
      ok: false,
      reason: 'Autopilot workers cannot access other projects',
    });
  });

  it('rejects protected brief, evaluator policy, limits and target writes', () => {
    for (const path of [
      '/api/projects/demo-app/autopilot/config',
      '/api/projects/demo-app/autopilot/start',
      '/api/projects/demo-app/autopilot/disable',
    ]) {
      const denied = decideAutopilotWorkerRequest(
        SCOPE,
        path.endsWith('config') ? 'PUT' : 'POST',
        path,
      );
      expect(denied.ok).toBe(false);
      expect(denied.reason).toMatch(/brief, evaluator policy, limits, target/i);
    }
  });

  it('rejects global endpoints and deployment configuration', () => {
    expect(decideAutopilotWorkerRequest(SCOPE, 'GET', '/api/config')).toEqual({
      ok: false,
      reason: 'Autopilot workers cannot access global Hub endpoints',
    });
    expect(decideAutopilotWorkerRequest(SCOPE, 'PATCH', '/api/config').ok).toBe(false);
    expect(decideAutopilotWorkerRequest(SCOPE, 'GET', '/api/auth/keys').ok).toBe(false);
    expect(
      decideAutopilotWorkerRequest(
        SCOPE,
        'PATCH',
        '/api/projects/demo-app/deploy/environments/prod',
      ).reason,
    ).toMatch(/deployment configuration/);
    expect(
      decideAutopilotWorkerRequest(SCOPE, 'POST', '/api/projects/demo-app/deployments').ok,
    ).toBe(false);
  });

  it("allows same-project Autopilot reads and this run's operation completion", () => {
    expect(decideAutopilotWorkerRequest(SCOPE, 'GET', '/api/projects/demo-app/autopilot').ok).toBe(
      true,
    );
    expect(
      decideAutopilotWorkerRequest(SCOPE, 'GET', '/api/projects/demo-app/autopilot/runs/run-1').ok,
    ).toBe(true);
    expect(
      decideAutopilotWorkerRequest(
        SCOPE,
        'POST',
        '/api/projects/demo-app/autopilot/operations/op-1/complete',
        { operation: SCOPE },
      ).ok,
    ).toBe(true);
  });

  it("rejects another run's operations and unlisted same-project writes", () => {
    expect(
      decideAutopilotWorkerRequest(SCOPE, 'GET', '/api/projects/demo-app/autopilot/runs/run-other')
        .ok,
    ).toBe(false);
    expect(
      decideAutopilotWorkerRequest(
        SCOPE,
        'POST',
        '/api/projects/demo-app/autopilot/operations/op-1/complete',
        { operation: { projectId: 'demo-app', runId: 'run-other' } },
      ).reason,
    ).toMatch(/another run/);
    expect(
      decideAutopilotWorkerRequest(
        SCOPE,
        'POST',
        '/api/projects/demo-app/autopilot/operations/op-1/complete',
      ).ok,
    ).toBe(false);
    expect(decideAutopilotWorkerRequest(SCOPE, 'GET', '/api/projects/demo-app/wiki').ok).toBe(
      false,
    );
  });
});

describe('applyAutopilotWorkerSpawnEnv', () => {
  it('replaces the break-glass API key and strips cloud and socket credentials', () => {
    const env = applyAutopilotWorkerSpawnEnv(
      {
        AGENT_HUB_API_KEY: 'ahub_global_break_glass',
        AWS_ACCESS_KEY_ID: 'AKIA',
        AWS_SECRET_ACCESS_KEY: 'secret',
        DOCKER_HOST: 'unix:///var/run/docker.sock',
        GOOGLE_APPLICATION_CREDENTIALS: '/host/creds.json',
      },
      { token: 'ahub_scoped_worker', projectId: 'demo-app', runId: 'run-1' },
    );
    expect(env.AGENT_HUB_API_KEY).toBe('ahub_scoped_worker');
    expect(env.PROJECT_ID).toBe('demo-app');
    expect(env.AGENT_HUB_AUTOPILOT_RUN_ID).toBe('run-1');
    expect(env.AWS_ACCESS_KEY_ID).toBeUndefined();
    expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(env.DOCKER_HOST).toBeUndefined();
    expect(env.GOOGLE_APPLICATION_CREDENTIALS).toBeUndefined();
  });
});

describe('autopilotWorkerGuard', () => {
  it('returns 403 for a cross-project request', async () => {
    const app = express();
    app.use((req, _res, next) => {
      (req as { authAutopilotWorker?: typeof SCOPE }).authAutopilotWorker = SCOPE;
      next();
    });
    app.use(autopilotWorkerGuard);
    app.get('/api/projects/:projectId/autopilot', (_req, res) => res.json({ ok: true }));

    const denied = await request(app).get('/api/projects/other-app/wiki');
    expect(denied.status).toBe(403);
    expect(denied.body.code).toBe('authority_denied');

    const allowed = await request(app).get('/api/projects/demo-app/autopilot');
    expect(allowed.status).toBe(200);
  });
});
