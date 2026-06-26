import '../test/setup.js';
import express, { type NextFunction, type Request, type Response } from 'express';
import request from 'supertest';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { EventEmitter, Readable } from 'stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getDb } from '../db.js';
import type { SpawnedStep } from '../finalize/step-runner.js';
import type { JobClaimSpec, RunnerBackend, RunnerLease } from '../finalize/runner-backend.js';
import type { Project, RouteDeps } from '../types.js';
import {
  acquireEnvironmentLock,
  createDeployment,
  ensureDeploymentEnvironment,
  getDeploymentEnvironment,
  listDeploymentApprovals,
  listDeploymentSteps,
  setEnvironmentCurrentRef,
  updateDeploymentStatus,
} from '../deploy/deployment-store.js';
import { loadDeployConfig, parseDeployConfig, type DeployConfig } from '../deploy/deploy-config.js';
import createDeploymentRoutes, {
  buildDeploySetupKickoffPrompt,
  isDeploySetupWizardSession,
} from './deployments.js';

const PROJECT_ID = 'deploy-route-proj';

const CONFIG = parseDeployConfig(`
version: 1
environments:
  dev:
    steps:
      - name: deploy
        run: ./deploy-dev.sh
  prod:
    approval: true
    steps:
      - name: deploy
        run: ./deploy-prod.sh
`);

async function flushBackgroundRun(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

function makeCheckoutDir(prefix: string): string {
  return mkdtempSync(path.join(tmpdir(), prefix));
}

function writeDeployYaml(root: string, raw: string): void {
  const dir = path.join(root, '.agent-hub');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'deploy.yaml'), raw);
}

function makeBackend(opts: { autoClose?: boolean; closeOnKill?: boolean } = {}): {
  backend: RunnerBackend;
  acquireCalls: JobClaimSpec[];
  killedSignals: (NodeJS.Signals | undefined)[];
  closeAll: (code: number) => void;
} {
  const acquireCalls: JobClaimSpec[] = [];
  const emitters: EventEmitter[] = [];
  const killedSignals: (NodeJS.Signals | undefined)[] = [];
  const lease: RunnerLease = {
    spawnStep() {
      const stdout = new Readable({ read() {} });
      const stderr = new Readable({ read() {} });
      const emitter = new EventEmitter();
      const child: SpawnedStep = {
        stdout,
        stderr,
        on(event: 'close' | 'error', listener: (arg: never) => void) {
          emitter.on(event, listener as never);
          return child;
        },
        kill(signal?: NodeJS.Signals) {
          killedSignals.push(signal);
          if (opts.closeOnKill !== false) setImmediate(() => emitter.emit('close', null));
          return true;
        },
      };
      emitters.push(emitter);
      if (opts.autoClose !== false) setImmediate(() => emitter.emit('close', 0));
      return child;
    },
    async release() {},
  };
  return {
    acquireCalls,
    killedSignals,
    closeAll(code: number) {
      for (const emitter of emitters) emitter.emit('close', code);
    },
    backend: {
      kind: 'fake',
      async acquire(spec) {
        acquireCalls.push(spec);
        return lease;
      },
    },
  };
}

function makeApp(
  opts: {
    role?: 'Owner' | 'Admin' | 'User' | null;
    config?: DeployConfig;
    autoCloseSteps?: boolean;
    closeOnKill?: boolean;
    agents?: Project['agents'];
    project?: Partial<Project>;
    handleChat?: RouteDeps['handleChat'];
    prepareCheckout?: (args: { project: Project; ref: string }) => Promise<{
      worktreePath: string;
      resolvedRef: string;
    }>;
    loadConfig?: (deployYamlPath: string) => Promise<DeployConfig>;
  } = {},
) {
  const backend = makeBackend({ autoClose: opts.autoCloseSteps, closeOnKill: opts.closeOnKill });
  const sessions = new Map<string, Record<string, unknown>>();
  const messages = new Map<string, Record<string, unknown>>();
  const project = {
    id: PROJECT_ID,
    name: 'Deploy Route Project',
    cwd: '/tmp/project',
    ahw: '/tmp/project',
    agents: opts.agents ?? [
      { id: 'agent-1', name: 'Dev', role: 'dev', engine: 'claude-code', model: 'claude-test' },
    ],
    ...opts.project,
  } as Project;
  const deps = {
    stmts: {
      createSession: {
        run(
          id: string,
          agentId: string,
          name: string,
          engine: string,
          model: string,
          useWorktree: number,
          askMode: number,
          wikiHybridRagBudgetVersion: number,
        ) {
          sessions.set(id, {
            id,
            agent_id: agentId,
            name,
            engine,
            model,
            use_worktree: useWorktree,
            ask_mode: askMode,
            wiki_hybrid_rag_budget_version: wikiHybridRagBudgetVersion,
          });
        },
      },
      getSession: {
        get(id: string) {
          return sessions.get(id) ?? null;
        },
      },
      addMessage: {
        run(
          id: string,
          sessionId: string,
          role: string,
          content: string,
          engine: string,
          model: string,
          attachments: string | null,
          metadata: string | null,
          agentId: string | null,
          agentName: string | null,
          agentColor: string | null,
        ) {
          messages.set(id, {
            id,
            session_id: sessionId,
            role,
            content,
            engine,
            model,
            attachments,
            metadata,
            agent_id: agentId,
            agent_name: agentName,
            agent_color: agentColor,
          });
        },
      },
      touchSession: {
        run() {},
      },
      getMessageById: {
        get(id: string) {
          return messages.get(id) ?? null;
        },
      },
    } as unknown as RouteDeps['stmts'],
    broadcast: vi.fn(),
    findProject: (id: string) => (id === PROJECT_ID ? project : null),
    findAgent: (id: string) => {
      const agent = project.agents.find((candidate) => candidate.id === id);
      return agent ? { project, agent } : null;
    },
    handleChat: opts.handleChat ?? vi.fn(async () => undefined),
    config: { dataDir: '/tmp' },
  } as unknown as RouteDeps;
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    const role = opts.role === undefined ? 'Owner' : opts.role;
    if (role) (req as unknown as { authRole?: string }).authRole = role;
    (req as unknown as { authUserId?: string }).authUserId = 'user-1';
    next();
  });
  app.use(
    createDeploymentRoutes(deps, {
      prepareCheckout:
        opts.prepareCheckout ??
        (async ({ ref }) => ({ worktreePath: `/tmp/deploy-${ref}`, resolvedRef: `${ref}-sha` })),
      loadConfig: opts.loadConfig ?? (async () => opts.config ?? CONFIG),
      orchestratorDeps: { runnerBackend: backend.backend, env: { PATH: '/usr/bin' } },
    }),
  );
  return { app, backend, deps, sessions, messages };
}

beforeEach(() => {
  const db = getDb();
  db.exec('DELETE FROM deployment_approvals;');
  db.exec('DELETE FROM deployment_steps;');
  db.exec('DELETE FROM deployments;');
  db.exec('DELETE FROM deployment_environments;');
});

describe('deployment routes', () => {
  it('matches deploy setup wizard session names', () => {
    expect(isDeploySetupWizardSession({ name: '[Deploy Setup] demo' })).toBe(true);
    expect(isDeploySetupWizardSession({ name: '[Preview Setup] demo' })).toBe(false);
  });

  it('builds a deploy setup prompt that loads the deploy setup skill', () => {
    const prompt = buildDeploySetupKickoffPrompt(PROJECT_ID, '/tmp/project', 'session-1');

    expect(prompt).toContain('.agent-hub/deploy.yaml');
    expect(prompt).toContain('version: 1');
    expect(prompt).toContain('"name":"deploy-setup"');
    expect(prompt).toContain('session-1');
  });

  it('starts a worktree-backed deploy setup wizard session', async () => {
    const { app, deps } = makeApp();

    const res = await request(app)
      .post(`/api/projects/${PROJECT_ID}/deploy/setup-wizard`)
      .send({})
      .expect(201);

    expect(res.body.sessionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(res.body.agentId).toBe('agent-1');
    expect(res.body.configPath).toBe('.agent-hub/deploy.yaml');
    expect(res.body.session).toMatchObject({
      id: res.body.sessionId,
      agent_id: 'agent-1',
      name: '[Deploy Setup] Deploy Route Project',
      use_worktree: 1,
      ask_mode: 0,
    });
    expect(deps.handleChat).toHaveBeenCalledWith(null, {
      type: 'chat',
      agentId: 'agent-1',
      sessionId: res.body.sessionId,
      content: expect.stringContaining('"name":"deploy-setup"'),
    });
    expect(deps.broadcast).toHaveBeenCalledWith({
      type: 'deploy_wizard_started',
      projectId: PROJECT_ID,
      sessionId: res.body.sessionId,
      agentId: 'agent-1',
    });
  });

  it('selects an active coding agent instead of the first project agent', async () => {
    const { app } = makeApp({
      agents: [
        { id: 'reviewer-1', name: 'Reviewer', role: 'reviewer', engine: 'claude-code' },
        { id: 'ceo-1', name: 'CEO', engine: 'claude-code' },
        { id: 'dev-1', name: 'Dev', role: 'dev', engine: 'claude-code' },
      ],
    });

    const res = await request(app)
      .post(`/api/projects/${PROJECT_ID}/deploy/setup-wizard`)
      .send({})
      .expect(201);

    expect(res.body.agentId).toBe('dev-1');
  });

  it('rejects deploy setup when the project has no coding agent', async () => {
    const { app } = makeApp({
      agents: [
        { id: 'reviewer-1', name: 'Reviewer', role: 'reviewer', engine: 'claude-code' },
        { id: 'ceo-1', name: 'CEO', engine: 'claude-code' },
      ],
    });

    const res = await request(app)
      .post(`/api/projects/${PROJECT_ID}/deploy/setup-wizard`)
      .send({})
      .expect(400);

    expect(res.body.error).toContain('no active coding/dev agents');
  });

  it('persists kickoff failures into the setup session', async () => {
    const { app, messages } = makeApp({
      handleChat: vi.fn(async () => {
        throw new Error('skill deploy-setup not found');
      }),
    });

    const res = await request(app)
      .post(`/api/projects/${PROJECT_ID}/deploy/setup-wizard`)
      .send({})
      .expect(201);
    await new Promise((resolve) => setImmediate(resolve));

    const failure = [...messages.values()].find(
      (message) => message.session_id === res.body.sessionId,
    );
    expect(failure).toMatchObject({
      role: 'assistant',
      content:
        'Deploy setup kickoff failed before instructions could be sent: skill deploy-setup not found',
      metadata: JSON.stringify({ kind: 'deploy_setup_kickoff_failure' }),
      agent_id: 'agent-1',
      agent_name: 'Dev',
    });
  });

  it('rejects deploy setup wizard starts below Admin role', async () => {
    const { app } = makeApp({ role: 'User' });

    await request(app).post(`/api/projects/${PROJECT_ID}/deploy/setup-wizard`).send({}).expect(403);
  });

  it('triggers a deployment and returns a status payload', async () => {
    const checkout = makeCheckoutDir('deploy-route-trigger-');
    const { app, backend } = makeApp({
      prepareCheckout: async ({ ref }) => ({
        worktreePath: checkout,
        resolvedRef: `${ref}-sha`,
      }),
    });
    const res = await request(app)
      .post(`/api/projects/${PROJECT_ID}/deployments`)
      .send({ environment: 'dev', ref: 'main' })
      .expect(202);

    expect(res.body.deployment).toMatchObject({
      project_id: PROJECT_ID,
      environment: 'dev',
      ref: 'main-sha',
      trigger: 'manual',
      triggered_by: 'user-1',
    });
    expect(res.body.steps.map((s: { name: string }) => s.name)).toEqual(['deploy']);
    expect(backend.acquireCalls[0].worktreePath).toBe(checkout);
    await flushBackgroundRun();
    expect(existsSync(checkout)).toBe(false);
  });

  it('renders deploy.yaml environments with live ref, last deployment, and rollback target', async () => {
    ensureDeploymentEnvironment(PROJECT_ID, 'dev');
    const previous = createDeployment({
      projectId: PROJECT_ID,
      environment: 'dev',
      ref: 'previous-sha',
      status: 'success',
    });
    const current = createDeployment({
      projectId: PROJECT_ID,
      environment: 'dev',
      ref: 'current-sha',
      status: 'success',
    });
    setEnvironmentCurrentRef(PROJECT_ID, 'dev', 'current-sha', current.id);

    const { app } = makeApp();
    const res = await request(app).get(`/api/projects/${PROJECT_ID}/deploy/config`).expect(200);

    expect(res.body).toMatchObject({
      projectId: PROJECT_ID,
      configPath: '.agent-hub/deploy.yaml',
    });
    expect(res.body.environments).toHaveLength(2);
    expect(res.body.environments[0]).toMatchObject({
      name: 'dev',
      approval: false,
      runsOn: 'ubuntu-24.04',
      timeoutMinutes: 60,
      currentRef: 'current-sha',
      currentDeploymentId: current.id,
      activeDeploymentId: null,
      currentDeployment: { id: current.id, ref: 'current-sha', status: 'success' },
      lastDeployment: { id: current.id, ref: 'current-sha', status: 'success' },
      rollbackTarget: { id: previous.id, ref: 'previous-sha', status: 'success' },
    });
    expect(res.body.environments[0].steps).toEqual([{ name: 'deploy', run: './deploy-dev.sh' }]);
    expect(res.body.environments[1]).toMatchObject({
      name: 'prod',
      approval: true,
    });
  });

  it('renders hosted deploy config from a prepared checkout when project cwd is stale', async () => {
    const staleCwd = makeCheckoutDir('deploy-route-stale-cwd-');
    const checkout = makeCheckoutDir('deploy-route-hosted-checkout-');
    writeDeployYaml(
      checkout,
      `
version: 1
environments:
  production:
    approval: true
    steps:
      - name: release
        run: ./release.sh
`,
    );
    const prepareCheckout = vi.fn(async () => ({
      worktreePath: checkout,
      resolvedRef: 'hosted-head-sha',
    }));
    const { app } = makeApp({
      project: { cwd: staleCwd, ahw: staleCwd, gitHost: 'agenthub' },
      prepareCheckout,
      loadConfig: loadDeployConfig,
    });

    const res = await request(app).get(`/api/projects/${PROJECT_ID}/deploy/config`).expect(200);

    expect(prepareCheckout).toHaveBeenCalledWith({
      project: expect.objectContaining({ id: PROJECT_ID, gitHost: 'agenthub', cwd: staleCwd }),
      ref: 'HEAD',
    });
    expect(res.body.environments).toHaveLength(1);
    expect(res.body.environments[0]).toMatchObject({
      name: 'production',
      approval: true,
      steps: [{ name: 'release', run: './release.sh' }],
    });
    await vi.waitFor(() => expect(existsSync(checkout)).toBe(false));
  });

  it('renders deploy config when environment rows reference deleted deployments', async () => {
    ensureDeploymentEnvironment(PROJECT_ID, 'dev');
    const active = createDeployment({
      projectId: PROJECT_ID,
      environment: 'dev',
      ref: 'active-sha',
      status: 'running',
    });
    const current = createDeployment({
      projectId: PROJECT_ID,
      environment: 'dev',
      ref: 'current-sha',
      status: 'success',
    });
    acquireEnvironmentLock(PROJECT_ID, 'dev', active.id);
    setEnvironmentCurrentRef(PROJECT_ID, 'dev', 'current-sha', current.id);
    getDb().prepare('DELETE FROM deployments WHERE id IN (?, ?)').run(active.id, current.id);

    const { app } = makeApp();
    const res = await request(app).get(`/api/projects/${PROJECT_ID}/deploy/config`).expect(200);

    expect(res.body.environments[0]).toMatchObject({
      name: 'dev',
      currentRef: 'current-sha',
      currentDeploymentId: current.id,
      activeDeploymentId: active.id,
      activeDeployment: null,
      currentDeployment: null,
      lastDeployment: null,
      rollbackTarget: null,
    });
  });

  it('lists deployments and returns detail with steps approvals environment and history', async () => {
    const dep = createDeployment({ projectId: PROJECT_ID, environment: 'dev', ref: 'abc' });
    ensureDeploymentEnvironment(PROJECT_ID, 'dev');

    const { app } = makeApp();
    const list = await request(app)
      .get(`/api/projects/${PROJECT_ID}/deployments?environment=dev`)
      .expect(200);
    expect(list.body.deployments.map((d: { id: string }) => d.id)).toEqual([dep.id]);

    const detail = await request(app)
      .get(`/api/projects/${PROJECT_ID}/deployments/${dep.id}`)
      .expect(200);
    expect(detail.body.deployment.id).toBe(dep.id);
    expect(detail.body.steps).toEqual([]);
    expect(detail.body.approvals).toEqual([]);
    expect(detail.body.environment.name).toBe('dev');
    expect(detail.body.history.map((d: { id: string }) => d.id)).toContain(dep.id);
    expect(detail.body.logs).toEqual([]);
  });

  it('maps a busy environment to 409 before creating a new runnable deployment', async () => {
    ensureDeploymentEnvironment(PROJECT_ID, 'dev');
    const existing = createDeployment({
      projectId: PROJECT_ID,
      environment: 'dev',
      ref: 'old',
      status: 'running',
    });
    acquireEnvironmentLock(PROJECT_ID, 'dev', existing.id);

    const prepareCheckout = vi.fn(async ({ ref }: { project: Project; ref: string }) => ({
      worktreePath: `/tmp/deploy-${ref}`,
      resolvedRef: `${ref}-sha`,
    }));
    const { app } = makeApp({ prepareCheckout });
    const res = await request(app)
      .post(`/api/projects/${PROJECT_ID}/deployments`)
      .send({ environment: 'dev', ref: 'main' })
      .expect(409);
    expect(res.body.activeDeploymentId).toBe(existing.id);
    expect(prepareCheckout).not.toHaveBeenCalled();
  });

  it('parks a gated deployment and requires Admin+ approval to resume it', async () => {
    const checkout = makeCheckoutDir('deploy-route-gated-');
    const gated = makeApp({
      prepareCheckout: async ({ ref }) => ({
        worktreePath: checkout,
        resolvedRef: `${ref}-sha`,
      }),
    });
    const trigger = await request(gated.app)
      .post(`/api/projects/${PROJECT_ID}/deployments`)
      .send({ environment: 'prod', ref: 'release' })
      .expect(202);
    const deploymentId = trigger.body.deployment.id as string;
    expect(trigger.body.deployment.status).toBe('awaiting_approval');
    expect(existsSync(checkout)).toBe(true);

    const user = makeApp({ role: 'User' });
    await request(user.app)
      .post(`/api/projects/${PROJECT_ID}/deployments/${deploymentId}/approve`)
      .send({ note: 'ship' })
      .expect(403);

    const admin = makeApp({ role: 'Admin' });
    const approved = await request(admin.app)
      .post(`/api/projects/${PROJECT_ID}/deployments/${deploymentId}/approve`)
      .send({ note: 'ship' })
      .expect(202);

    expect(approved.body.approvals).toHaveLength(1);
    expect(approved.body.approvals[0]).toMatchObject({
      approver_user_id: 'user-1',
      approver_role: 'Admin',
      note: 'ship',
    });
    expect(listDeploymentApprovals(deploymentId)).toHaveLength(1);
    await flushBackgroundRun();
    expect(existsSync(checkout)).toBe(false);
  });

  it('only one concurrent approval caller can record an approval', async () => {
    const { app } = makeApp();
    const trigger = await request(app)
      .post(`/api/projects/${PROJECT_ID}/deployments`)
      .send({ environment: 'prod', ref: 'release' })
      .expect(202);
    const deploymentId = trigger.body.deployment.id as string;

    await request(app)
      .post(`/api/projects/${PROJECT_ID}/deployments/${deploymentId}/approve`)
      .send({})
      .expect(202);
    await request(app)
      .post(`/api/projects/${PROJECT_ID}/deployments/${deploymentId}/approve`)
      .send({})
      .expect(409);

    expect(listDeploymentApprovals(deploymentId)).toHaveLength(1);
  });

  it('cancels an awaiting deployment and releases the environment lock', async () => {
    const checkout = makeCheckoutDir('deploy-route-cancel-awaiting-');
    const { app } = makeApp({
      prepareCheckout: async ({ ref }) => ({
        worktreePath: checkout,
        resolvedRef: `${ref}-sha`,
      }),
    });
    const trigger = await request(app)
      .post(`/api/projects/${PROJECT_ID}/deployments`)
      .send({ environment: 'prod', ref: 'release' })
      .expect(202);
    const deploymentId = trigger.body.deployment.id as string;
    expect(existsSync(checkout)).toBe(true);

    const cancelled = await request(app)
      .post(`/api/projects/${PROJECT_ID}/deployments/${deploymentId}/cancel`)
      .send({ reason: 'operator cancelled' })
      .expect(202);

    expect(cancelled.body.deployment.status).toBe('cancelled');
    expect(listDeploymentSteps(deploymentId).map((s) => s.status)).toEqual(['cancelled']);
    expect(getDeploymentEnvironment(PROJECT_ID, 'prod')?.active_deployment_id).toBeNull();
    expect(existsSync(checkout)).toBe(false);
  });

  it('signals a running deployment on cancel and releases the lock after runner exit', async () => {
    const checkout = makeCheckoutDir('deploy-route-cancel-running-');
    const { app, backend } = makeApp({
      autoCloseSteps: false,
      closeOnKill: false,
      prepareCheckout: async ({ ref }) => ({
        worktreePath: checkout,
        resolvedRef: `${ref}-sha`,
      }),
    });
    const trigger = await request(app)
      .post(`/api/projects/${PROJECT_ID}/deployments`)
      .send({ environment: 'dev', ref: 'main' })
      .expect(202);
    const deploymentId = trigger.body.deployment.id as string;
    expect(existsSync(checkout)).toBe(true);

    await request(app)
      .post(`/api/projects/${PROJECT_ID}/deployments/${deploymentId}/cancel`)
      .send({ reason: 'stop' })
      .expect(202);

    expect(backend.killedSignals).toContain('SIGTERM');
    expect(getDeploymentEnvironment(PROJECT_ID, 'dev')?.active_deployment_id).toBe(deploymentId);

    backend.closeAll(0);
    await flushBackgroundRun();

    const detail = await request(app)
      .get(`/api/projects/${PROJECT_ID}/deployments/${deploymentId}`)
      .expect(200);
    expect(detail.body.deployment.status).toBe('cancelled');
    expect(detail.body.steps.map((s: { status: string }) => s.status)).toEqual(['cancelled']);
    expect(getDeploymentEnvironment(PROJECT_ID, 'dev')?.active_deployment_id).toBeNull();
    expect(existsSync(checkout)).toBe(false);
  });

  it('rolls back by redeploying the source deployment ref as trigger=rollback', async () => {
    const source = createDeployment({ projectId: PROJECT_ID, environment: 'dev', ref: 'good-sha' });
    updateDeploymentStatus(source.id, 'success');

    const { app } = makeApp({
      prepareCheckout: async ({ ref }) => ({
        worktreePath: `/tmp/rollback-${ref}`,
        resolvedRef: ref,
      }),
    });
    const res = await request(app)
      .post(`/api/projects/${PROJECT_ID}/deployments/${source.id}/rollback`)
      .send({})
      .expect(202);

    expect(res.body.deployment).toMatchObject({
      environment: 'dev',
      ref: 'good-sha',
      trigger: 'rollback',
      source_deployment_id: source.id,
    });
  });

  it('refuses rollback from a non-success deployment', async () => {
    const source = createDeployment({ projectId: PROJECT_ID, environment: 'dev', ref: 'bad-sha' });
    const { app } = makeApp();
    await request(app)
      .post(`/api/projects/${PROJECT_ID}/deployments/${source.id}/rollback`)
      .send({})
      .expect(400);
  });
});
