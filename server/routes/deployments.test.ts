import '../test/setup.js';
import express, { type NextFunction, type Request, type Response } from 'express';
import request from 'supertest';
import { existsSync, mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { EventEmitter, Readable } from 'stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getDb } from '../db.js';
import { wipeTables } from '../test/destructive-db.js';
import type { SpawnedStep } from '../finalize/step-runner.js';
import type { JobClaimSpec, RunnerBackend, RunnerLease } from '../finalize/runner-backend.js';
import type { Project, RouteDeps } from '../types.js';
import {
  acquireEnvironmentLock,
  addDeploymentStep,
  createDeployment,
  ensureDeploymentEnvironment,
  ensureDeploymentReleaseItem,
  getDeploymentEnvironment,
  listDeploymentApprovals,
  listDeploymentSteps,
  setEnvironmentCurrentRef,
  setDeploymentReleaseItemInclusion,
  updateDeploymentStepStatus,
  updateDeploymentStatus,
} from '../deploy/deployment-store.js';
import { parseDeployConfig, type DeployConfig } from '../deploy/deploy-config.js';
import {
  getEnvironmentConfig,
  setEnvironmentEnabled,
  upsertEnvironmentConfig,
} from '../deploy/deployment-env-config-store.js';
import { createTrigger, listTriggersForEnvironment } from '../deploy/deployment-trigger-store.js';
import {
  getNotificationRouting,
  upsertNotificationRouting,
} from '../deploy/deployment-notification-routing-store.js';
import {
  createSchedule,
  listSchedulesForEnvironment,
} from '../deploy/deployment-schedule-store.js';
import {
  createReleaseGate,
  listReleaseGatesForEnvironment,
} from '../deploy/deployment-release-gate-store.js';
import { DeployConfigError } from '../deploy/deploy-config-error.js';
import { createSupportTicket, recordSupportTicketInvestigation } from '../support-tickets-store.js';
import {
  addReleaseDigestRecipient,
  updateReleaseNotificationSettings,
} from '../release-notification-settings.js';
import {
  enqueueReleaseNotificationOutbox,
  listReleaseNotificationOutboxByDeployment,
  markReleaseNotificationOutboxError,
} from '../release-notification-outbox.js';
import {
  EMPTY_RELEASE_DIGEST_MARKDOWN,
  RELEASE_DIGEST_FACTS_PREAMBLE,
  RELEASE_DIGEST_GENERATION_INSTRUCTIONS,
  RELEASE_DIGEST_ITEM_LIMIT,
  RELEASE_DIGEST_TEXT_FIELD_MAX_BYTES,
  type ReleaseDigestRunner,
} from '../release-digest.js';
import { RELEASE_DIGEST_GROUPING_AND_COVERAGE_RULES } from '../release-digest-prompt.js';
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
        on(event: 'close' | 'exit' | 'error', listener: (arg: never) => void) {
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
    readDeployConfig?: (project: Project) => Promise<DeployConfig>;
    releaseDigestRunner?: ReleaseDigestRunner;
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
      readDeployConfig: opts.readDeployConfig,
      orchestratorDeps: { runnerBackend: backend.backend, env: { PATH: '/usr/bin' } },
      releaseDigestRunner: opts.releaseDigestRunner,
    }),
  );
  return { app, backend, deps, sessions, messages };
}

beforeEach(() => {
  // wipeTables refuses to run against a non-scratch (non-tmpdir) database —
  // see server/test/destructive-db.ts and the 2026-07-01 prod wipe incident.
  wipeTables(getDb(), [
    'deployment_release_items',
    'deployment_approvals',
    'deployment_steps',
    'release_notification_outbox',
    'deployments',
    'deployment_environments',
    'deployment_env_runtime_config',
    'deployment_env_trigger',
    'deployment_env_schedule',
    'deployment_env_release_gate',
    'deployment_env_notification_routing',
    'release_notification_settings',
    'kanban_cards',
    'kanban_columns',
    'kanban_boards',
    'sessions',
    'support_tickets',
  ]);
});

function insertReleaseCard(
  cardId: string,
  projectId = PROJECT_ID,
  opts: {
    supportTicketId?: string | null;
    title?: string;
    description?: string | null;
    labels?: string | null;
  } = {},
): string {
  const boardId = `board-${cardId}`;
  const columnId = `col-${cardId}`;
  const db = getDb();
  db.prepare('INSERT INTO kanban_boards (id, project_id, name) VALUES (?, ?, ?)').run(
    boardId,
    projectId,
    'Board',
  );
  db.prepare('INSERT INTO kanban_columns (id, board_id, name, position) VALUES (?, ?, ?, ?)').run(
    columnId,
    boardId,
    'Done',
    0,
  );
  db.prepare(
    `INSERT INTO kanban_cards
       (id, column_id, board_id, title, description, labels, support_ticket_id)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    cardId,
    columnId,
    boardId,
    opts.title ?? 'Release card',
    opts.description ?? null,
    opts.labels ?? null,
    opts.supportTicketId ?? null,
  );
  return cardId;
}

function extractReleaseDigestFacts(prompt: string): {
  releaseItems: Array<{ kind: string; card: { title: string } }>;
  groups: Array<{ key: string; label: string; itemIndexes: number[] }>;
  factLimits: { excludedReleaseItemCount: number };
} {
  const marker = `${RELEASE_DIGEST_FACTS_PREAMBLE}\n`;
  const start = prompt.indexOf(marker);
  expect(start).toBeGreaterThanOrEqual(0);
  const jsonStart = start + marker.length;
  const jsonEnd = prompt.indexOf(`\n\n${RELEASE_DIGEST_GENERATION_INSTRUCTIONS}`, jsonStart);
  expect(jsonEnd).toBeGreaterThan(jsonStart);
  return JSON.parse(prompt.slice(jsonStart, jsonEnd)) as {
    releaseItems: Array<{ kind: string; card: { title: string } }>;
    groups: Array<{ key: string; label: string; itemIndexes: number[] }>;
    factLimits: { excludedReleaseItemCount: number };
  };
}

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

  it('uses the release digest runner for automatic production digest emails', async () => {
    const checkout = makeCheckoutDir('deploy-route-digest-');
    const cardId = insertReleaseCard('route-generated-digest-card', PROJECT_ID, {
      title: 'Show customer release changes',
      labels: 'customer-facing',
    });
    addReleaseDigestRecipient({ projectId: PROJECT_ID, email: 'ops@example.com' });
    const releaseDigestRunner: ReleaseDigestRunner = vi.fn(async ({ prompt }) => {
      expect(prompt).toContain('Show customer release changes');
      return '## Release digest\n\nCustomers can now review shipped changes from deployments.';
    });
    const { app } = makeApp({
      config: parseDeployConfig(`
version: 1
environments:
  production:
    steps:
      - name: deploy
        run: ./deploy-production.sh
`),
      prepareCheckout: async ({ ref }) => ({
        worktreePath: checkout,
        resolvedRef: `${ref}-sha`,
      }),
      releaseDigestRunner,
    });

    const res = await request(app)
      .post(`/api/projects/${PROJECT_ID}/deployments`)
      .send({ environment: 'production', ref: 'main', meta: { cardIds: [cardId] } })
      .expect(202);

    const deploymentId = res.body.deployment.id as string;
    await vi.waitFor(() =>
      expect(listReleaseNotificationOutboxByDeployment(deploymentId)).toHaveLength(1),
    );
    const [digest] = listReleaseNotificationOutboxByDeployment(deploymentId);
    expect(releaseDigestRunner).toHaveBeenCalledTimes(1);
    expect(digest).toMatchObject({
      notification_type: 'release_digest',
      recipient_email: 'ops@example.com',
      body_text: '## Release digest\n\nCustomers can now review shipped changes from deployments.',
    });
    expect(digest?.body_text).not.toContain('1. Show customer release changes');
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

  it('reads hosted deploy config via the cheap blob read, never cloning', async () => {
    // For a hosted-git project the config comes from the repo blob at HEAD
    // (readDeployConfig), NOT a full clone into a worktree — that clone ran
    // ~11s on a large repo and hung the Deployments page. prepareCheckout must
    // not be touched on this read path.
    const staleCwd = makeCheckoutDir('deploy-route-stale-cwd-');
    const prepareCheckout = vi.fn(async () => ({
      worktreePath: '/tmp/should-not-be-used',
      resolvedRef: 'hosted-head-sha',
    }));
    const readDeployConfig = vi.fn(async () =>
      parseDeployConfig(
        `
version: 1
environments:
  production:
    approval: true
    steps:
      - name: release
        run: ./release.sh
`,
      ),
    );
    const { app } = makeApp({
      project: { cwd: staleCwd, ahw: staleCwd, gitHost: 'agenthub' },
      prepareCheckout,
      readDeployConfig,
    });

    const res = await request(app).get(`/api/projects/${PROJECT_ID}/deploy/config`).expect(200);

    expect(readDeployConfig).toHaveBeenCalledWith(
      expect.objectContaining({ id: PROJECT_ID, gitHost: 'agenthub', cwd: staleCwd }),
    );
    expect(prepareCheckout).not.toHaveBeenCalled();
    expect(res.body.environments).toHaveLength(1);
    expect(res.body.environments[0]).toMatchObject({
      name: 'production',
      approval: true,
      steps: [{ name: 'release', run: './release.sh' }],
    });
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

  it('does not surface terminal deployments as active environment runs', async () => {
    ensureDeploymentEnvironment(PROJECT_ID, 'dev');
    const terminal = createDeployment({
      projectId: PROJECT_ID,
      environment: 'dev',
      ref: 'terminal-sha',
      status: 'success',
    });
    expect(acquireEnvironmentLock(PROJECT_ID, 'dev', terminal.id)).toBe(true);

    const { app } = makeApp();
    const res = await request(app).get(`/api/projects/${PROJECT_ID}/deploy/config`).expect(200);

    expect(res.body.environments[0]).toMatchObject({
      name: 'dev',
      activeDeploymentId: null,
      activeDeployment: null,
      lastDeployment: { id: terminal.id, status: 'success' },
    });
  });

  it('lists deployments and returns detail with steps approvals environment and history', async () => {
    const dep = createDeployment({ projectId: PROJECT_ID, environment: 'dev', ref: 'abc' });
    ensureDeploymentEnvironment(PROJECT_ID, 'dev');
    const ticket = createSupportTicket({
      projectId: PROJECT_ID,
      subject: 'Login form fails',
      body: 'customer bug',
      type: 'bug',
    });
    const cardId = insertReleaseCard('release-card-route', PROJECT_ID, {
      supportTicketId: ticket.id,
      title: 'Fix login form',
    });
    const releaseItem = ensureDeploymentReleaseItem({ deploymentId: dep.id, cardId });

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
    expect(detail.body.releaseItems).toEqual([
      expect.objectContaining({
        id: releaseItem.id,
        deployment_id: dep.id,
        card_id: cardId,
        source: 'derived',
        inclusion_status: 'included',
        card: {
          id: cardId,
          title: 'Fix login form',
          shortId: expect.any(Number),
          priority: 'medium',
          columnName: 'Done',
        },
        supportTicket: {
          id: ticket.id,
          subject: 'Login form fails',
          status: 'new',
          type: 'bug',
          releaseState: null,
        },
      }),
    ]);
    expect(detail.body.releaseNotifications).toEqual([]);
    expect(detail.body.environment.name).toBe('dev');
    expect(detail.body.history.map((d: { id: string }) => d.id)).toContain(dep.id);
    expect(detail.body.logs).toEqual([]);

    const items = await request(app)
      .get(`/api/projects/${PROJECT_ID}/deployments/${dep.id}/release-items`)
      .expect(200);
    expect(items.body.releaseItems).toEqual(detail.body.releaseItems);
  });

  it('normalizes running steps on terminal deployment detail responses', async () => {
    const dep = createDeployment({ projectId: PROJECT_ID, environment: 'dev', ref: 'abc' });
    const step = addDeploymentStep({
      deploymentId: dep.id,
      name: 'trigger-release-all',
      stepOrder: 1,
    });
    updateDeploymentStepStatus(step.id, 'running');
    updateDeploymentStatus(dep.id, 'error', { error: 'poller was interrupted' });

    const { app } = makeApp();
    const detail = await request(app)
      .get(`/api/projects/${PROJECT_ID}/deployments/${dep.id}`)
      .expect(200);

    expect(detail.body.deployment.status).toBe('error');
    expect(detail.body.steps[0]).toMatchObject({
      id: step.id,
      status: 'error',
      error: 'poller was interrupted',
    });
  });

  it('returns safe release notification history and retries failed rows without duplicating them', async () => {
    const dep = createDeployment({ projectId: PROJECT_ID, environment: 'prod', ref: 'abc' });
    const failed = enqueueReleaseNotificationOutbox({
      projectId: PROJECT_ID,
      deploymentId: dep.id,
      notificationType: 'release_digest',
      idempotencyKey: 'retry-route-key',
      recipientEmail: 'ops@example.com',
      subject: 'Release digest',
      bodyText: 'Release body',
    });
    markReleaseNotificationOutboxError(failed.id, 'smtp host smtp.internal failed auth');
    getDb()
      .prepare('UPDATE release_notification_outbox SET attempts = 5 WHERE id = ?')
      .run(failed.id);

    const { app, deps } = makeApp();
    const detail = await request(app)
      .get(`/api/projects/${PROJECT_ID}/deployments/${dep.id}`)
      .expect(200);

    expect(detail.body.releaseNotifications).toEqual([
      expect.objectContaining({
        id: failed.id,
        notification_type: 'release_digest',
        recipient_type: 'release_digest',
        subject: 'Release digest',
        status: 'error',
        attempts: 5,
        sent_at: null,
        error_summary: 'Email delivery failed.',
        can_retry: true,
      }),
    ]);
    expect(JSON.stringify(detail.body.releaseNotifications)).not.toContain('smtp.internal');

    const retry = await request(app)
      .post(
        `/api/projects/${PROJECT_ID}/deployments/${dep.id}/release-notifications/${failed.id}/retry`,
      )
      .send({})
      .expect(200);

    expect(retry.body.notification).toMatchObject({
      id: failed.id,
      status: 'pending',
      attempts: 4,
      error_summary: null,
      can_retry: false,
    });
    expect(retry.body.releaseNotifications).toHaveLength(1);
    expect(
      getDb()
        .prepare(
          'SELECT COUNT(*) AS count FROM release_notification_outbox WHERE idempotency_key = ?',
        )
        .get('retry-route-key'),
    ).toMatchObject({ count: 1 });
    // Retrying flips the row back to pending and fans the change out over WS.
    expect(deps.broadcast).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'release_notification_update',
        projectId: PROJECT_ID,
        deploymentId: dep.id,
      }),
    );
    const wsEvent = (deps.broadcast as ReturnType<typeof vi.fn>).mock.calls
      .map((call) => call[0])
      .find((event) => event?.type === 'release_notification_update');
    expect(JSON.stringify(wsEvent)).not.toContain('ops@example.com');
  });

  it('requires Admin role to retry release notifications', async () => {
    const dep = createDeployment({ projectId: PROJECT_ID, environment: 'prod', ref: 'abc' });
    const failed = enqueueReleaseNotificationOutbox({
      projectId: PROJECT_ID,
      deploymentId: dep.id,
      notificationType: 'release_digest',
      idempotencyKey: 'retry-auth-key',
      recipientEmail: 'ops@example.com',
      subject: 'Release digest',
      bodyText: 'Release body',
    });
    markReleaseNotificationOutboxError(failed.id, 'send_failed');

    const { app } = makeApp({ role: 'User' });
    await request(app)
      .post(
        `/api/projects/${PROJECT_ID}/deployments/${dep.id}/release-notifications/${failed.id}/retry`,
      )
      .send({})
      .expect(403);
  });

  it('does not retry already sent release notifications', async () => {
    const dep = createDeployment({ projectId: PROJECT_ID, environment: 'prod', ref: 'abc' });
    const sent = enqueueReleaseNotificationOutbox({
      projectId: PROJECT_ID,
      deploymentId: dep.id,
      notificationType: 'release_digest',
      idempotencyKey: 'retry-sent-key',
      recipientEmail: 'ops@example.com',
      subject: 'Release digest',
      bodyText: 'Release body',
    });
    getDb()
      .prepare(
        "UPDATE release_notification_outbox SET status = 'sent', sent_at = datetime('now') WHERE id = ?",
      )
      .run(sent.id);

    const { app } = makeApp();
    await request(app)
      .post(
        `/api/projects/${PROJECT_ID}/deployments/${dep.id}/release-notifications/${sent.id}/retry`,
      )
      .send({})
      .expect(409);

    expect(
      getDb()
        .prepare(
          'SELECT COUNT(*) AS count FROM release_notification_outbox WHERE idempotency_key = ?',
        )
        .get('retry-sent-key'),
    ).toMatchObject({ count: 1 });
  });

  it('exposes release notification recipients (with email) to Admin callers', async () => {
    const dep = createDeployment({ projectId: PROJECT_ID, environment: 'prod', ref: 'abc' });
    const reporter = enqueueReleaseNotificationOutbox({
      projectId: PROJECT_ID,
      deploymentId: dep.id,
      supportTicketId: 'ticket-1',
      notificationType: 'ticket_release',
      idempotencyKey: 'recipients-reporter-key',
      recipientEmail: 'Reporter@Example.com',
      subject: 'Update on your support ticket',
      bodyText: 'Fix shipped',
    });
    const digest = enqueueReleaseNotificationOutbox({
      projectId: PROJECT_ID,
      deploymentId: dep.id,
      notificationType: 'release_digest',
      idempotencyKey: 'recipients-digest-key',
      recipientEmail: 'ops@example.com',
      subject: 'Release digest',
      bodyText: 'Release body',
    });
    markReleaseNotificationOutboxError(digest.id, 'smtp host smtp.internal failed auth');

    const { app } = makeApp({ role: 'Admin' });
    const res = await request(app)
      .get(`/api/projects/${PROJECT_ID}/deployments/${dep.id}/notification-recipients`)
      .expect(200);

    expect(res.body.recipients).toEqual([
      expect.objectContaining({
        id: reporter.id,
        notification_type: 'ticket_release',
        recipient_type: 'reporter',
        recipient_email: 'reporter@example.com',
        support_ticket_id: 'ticket-1',
        release_item_id: null,
        status: 'pending',
      }),
      expect.objectContaining({
        id: digest.id,
        notification_type: 'release_digest',
        recipient_type: 'release_digest',
        recipient_email: 'ops@example.com',
        status: 'error',
        error_summary: 'Email delivery failed.',
      }),
    ]);
    // Raw provider error and message body are never surfaced, even to Admin.
    const serialized = JSON.stringify(res.body.recipients);
    expect(serialized).not.toContain('smtp.internal');
    expect(serialized).not.toContain('Release body');
  });

  it('returns an empty recipient list for a deployment with no notifications', async () => {
    const dep = createDeployment({ projectId: PROJECT_ID, environment: 'prod', ref: 'abc' });
    const { app } = makeApp({ role: 'Admin' });
    const res = await request(app)
      .get(`/api/projects/${PROJECT_ID}/deployments/${dep.id}/notification-recipients`)
      .expect(200);
    expect(res.body).toEqual({ recipients: [] });
  });

  it('requires Admin role to read release notification recipients', async () => {
    const dep = createDeployment({ projectId: PROJECT_ID, environment: 'prod', ref: 'abc' });
    enqueueReleaseNotificationOutbox({
      projectId: PROJECT_ID,
      deploymentId: dep.id,
      notificationType: 'release_digest',
      idempotencyKey: 'recipients-auth-key',
      recipientEmail: 'ops@example.com',
      subject: 'Release digest',
      bodyText: 'Release body',
    });

    const { app } = makeApp({ role: 'User' });
    await request(app)
      .get(`/api/projects/${PROJECT_ID}/deployments/${dep.id}/notification-recipients`)
      .expect(403);
  });

  it('returns 404 reading recipients for an unknown deployment', async () => {
    const { app } = makeApp({ role: 'Admin' });
    await request(app)
      .get(`/api/projects/${PROJECT_ID}/deployments/does-not-exist/notification-recipients`)
      .expect(404);
  });

  it('generates a release digest draft with the stored project prompt inside the fixed template', async () => {
    const dep = createDeployment({
      projectId: PROJECT_ID,
      environment: 'production',
      ref: 'release-sha',
      status: 'success',
    });
    const ticket = createSupportTicket({
      projectId: PROJECT_ID,
      subject: 'Export fails',
      body: 'CSV export fails for customers',
      type: 'bug',
    });
    recordSupportTicketInvestigation(ticket.id, {
      summary: 'CSV export generated blank files for paid workspaces.',
    });
    const includedCardId = insertReleaseCard('release-digest-included', PROJECT_ID, {
      supportTicketId: ticket.id,
      title: 'Fix CSV export',
      description: 'CSV exports now include all filtered rows.',
      labels: 'customer-facing,exports',
    });
    const excludedCardId = insertReleaseCard('release-digest-excluded', PROJECT_ID, {
      title: 'Internal migration',
    });
    ensureDeploymentReleaseItem({ deploymentId: dep.id, cardId: includedCardId });
    ensureDeploymentReleaseItem({ deploymentId: dep.id, cardId: excludedCardId });
    setDeploymentReleaseItemInclusion({
      deploymentId: dep.id,
      cardId: excludedCardId,
      inclusionStatus: 'excluded',
      adjustedBy: 'admin-1',
      note: 'internal only',
    });
    updateReleaseNotificationSettings({
      projectId: PROJECT_ID,
      releaseDigestPrompt: 'Put support-ticket fixes first and use a concise customer tone.',
      updatedBy: 'admin-1',
    });
    const prompts: string[] = [];
    const releaseDigestRunner: ReleaseDigestRunner = vi.fn(async ({ prompt }) => {
      prompts.push(prompt);
      return '## Release digest\n\nCSV export is fixed.';
    });

    const { app } = makeApp({ role: 'Admin', releaseDigestRunner });
    const response = await request(app)
      .post(`/api/projects/${PROJECT_ID}/deployments/${dep.id}/release-digest`)
      .send({})
      .expect(200);

    expect(releaseDigestRunner).toHaveBeenCalledTimes(1);
    expect(prompts[0]).toContain('Put support-ticket fixes first and use a concise customer tone.');
    expect(prompts[0]).toContain('Do not expose secrets');
    expect(prompts[0]).toContain('Fix CSV export');
    expect(prompts[0]).toContain('CSV exports now include all filtered rows.');
    expect(prompts[0]).toContain('customer-facing');
    expect(prompts[0]).toContain('"status": "Done"');
    expect(prompts[0]).toContain('Export fails');
    expect(prompts[0]).toContain('CSV export generated blank files for paid workspaces.');
    expect(prompts[0]).not.toContain('Internal migration');
    expect(prompts[0]).toContain('not a required outline');
    expect(prompts[0]).toContain('Account for every included release item');
    const facts = extractReleaseDigestFacts(prompts[0]);
    expect(facts.releaseItems[0]?.kind).toBe('support-ticket-resolutions');
    expect(facts.groups).toEqual([
      {
        key: 'support-ticket-resolutions',
        label: 'Support-ticket resolutions',
        itemIndexes: [0],
      },
    ]);
    expect(facts.factLimits.excludedReleaseItemCount).toBe(1);
    expect(response.body).toMatchObject({
      digestMarkdown: '## Release digest\n\nCSV export is fixed.',
      settings: { isDefault: false },
    });
    expect(response.body).not.toHaveProperty('prompt');
    expect(response.body).not.toHaveProperty('facts');
  });

  it('treats Hub groups as a hint so operator department grouping can be the outline', async () => {
    const dep = createDeployment({
      projectId: PROJECT_ID,
      environment: 'production',
      ref: 'release-sha',
      status: 'success',
    });
    const ticket = createSupportTicket({
      projectId: PROJECT_ID,
      subject: 'Comp report wrong value',
      body: 'Boundary job showed $11200 instead of $5600',
      type: 'bug',
    });
    recordSupportTicketInvestigation(ticket.id, {
      summary: 'Sales comp report showed $11,200 for a Boundary job; correct value is $5,600.',
    });
    const ticketCardId = insertReleaseCard('release-digest-ticket', PROJECT_ID, {
      supportTicketId: ticket.id,
      title: 'Fix comp report for cancelled and recreated orders',
      description: 'Sales comp now uses the recreated order value.',
      labels: 'bug',
    });
    const draftingCardId = insertReleaseCard('release-digest-drafting', PROJECT_ID, {
      title: 'Place LE/UE easement labels at the end of the line',
      description: 'Easement labels render at the end of the line in Beyond CAD.',
      labels: 'drafting',
    });
    const adminCardId = insertReleaseCard('release-digest-admin', PROJECT_ID, {
      title: 'Revise Pricing and Delivery Estimates for Clarity',
      description: 'Pricing and delivery estimate copy is clearer on order forms.',
      labels: 'admin',
    });
    ensureDeploymentReleaseItem({ deploymentId: dep.id, cardId: ticketCardId });
    ensureDeploymentReleaseItem({ deploymentId: dep.id, cardId: draftingCardId });
    ensureDeploymentReleaseItem({ deploymentId: dep.id, cardId: adminCardId });
    updateReleaseNotificationSettings({
      projectId: PROJECT_ID,
      releaseDigestPrompt: [
        'Split the digest by departments: Admin, Field, Drafting, Research.',
        'This goes out to Acme employees from the Product Team.',
      ].join('\n'),
      updatedBy: 'admin-1',
    });
    const prompts: string[] = [];
    const releaseDigestRunner: ReleaseDigestRunner = vi.fn(async ({ prompt }) => {
      prompts.push(prompt);
      return '## Drafting\n\nEasement labels now sit at the end of the line.';
    });

    const { app } = makeApp({ role: 'Admin', releaseDigestRunner });
    await request(app)
      .post(`/api/projects/${PROJECT_ID}/deployments/${dep.id}/release-digest`)
      .send({})
      .expect(200);

    expect(prompts[0]).toContain(
      'Split the digest by departments: Admin, Field, Drafting, Research.',
    );
    expect(prompts[0]).toContain('This goes out to Acme employees from the Product Team.');
    expect(prompts[0]).toContain(RELEASE_DIGEST_GROUPING_AND_COVERAGE_RULES);
    expect(RELEASE_DIGEST_GENERATION_INSTRUCTIONS).toContain(
      RELEASE_DIGEST_GROUPING_AND_COVERAGE_RULES,
    );
    expect(prompts[0]).toContain('not a required outline');
    expect(prompts[0]).toContain(
      'Do not copy those group labels as section headings when operator guidance specifies a different grouping',
    );
    expect(prompts[0]).toContain('Account for every included release item');
    expect(prompts[0]).toContain('do not drop a distinct customer-visible change');
    expect(prompts[0]).toContain('Do not include a Subject line');
    expect(prompts[0]).toContain('Place LE/UE easement labels at the end of the line');
    expect(prompts[0]).toContain('Revise Pricing and Delivery Estimates for Clarity');
    const facts = extractReleaseDigestFacts(prompts[0]);
    expect(facts.releaseItems.map((item) => item.kind)).toEqual([
      'support-ticket-resolutions',
      'other-customer-visible-changes',
      'other-customer-visible-changes',
    ]);
    expect(facts.groups.map((group) => group.label)).toEqual([
      'Support-ticket resolutions',
      'Other customer-visible changes',
    ]);
  });

  it('bounds oversized release digest facts before invoking the model', async () => {
    const dep = createDeployment({
      projectId: PROJECT_ID,
      environment: 'production',
      ref: 'release-sha',
      status: 'success',
    });
    const longDescriptionTail = 'DESCRIPTION_TAIL_SHOULD_NOT_APPEAR';
    const longSummaryTail = 'SUMMARY_TAIL_SHOULD_NOT_APPEAR';
    const ticket = createSupportTicket({
      projectId: PROJECT_ID,
      subject: 'Large export fails',
      body: 'CSV export fails for customers',
      type: 'bug',
    });
    recordSupportTicketInvestigation(ticket.id, {
      summary: `${'S'.repeat(RELEASE_DIGEST_TEXT_FIELD_MAX_BYTES + 100)}${longSummaryTail}`,
    });

    for (let i = 0; i < RELEASE_DIGEST_ITEM_LIMIT + 2; i += 1) {
      const title =
        i >= RELEASE_DIGEST_ITEM_LIMIT ? `Beyond cap release item ${i}` : `Bulk release item ${i}`;
      const cardId = insertReleaseCard(`release-digest-bulk-${i}`, PROJECT_ID, {
        supportTicketId: i === 0 ? ticket.id : null,
        title,
        description:
          i === 0
            ? `${'D'.repeat(RELEASE_DIGEST_TEXT_FIELD_MAX_BYTES + 100)}${longDescriptionTail}`
            : `Description ${i}`,
        labels: Array.from({ length: 30 }, (_v, idx) => `label-${idx}`).join(','),
      });
      ensureDeploymentReleaseItem({ deploymentId: dep.id, cardId });
    }

    const prompts: string[] = [];
    const releaseDigestRunner: ReleaseDigestRunner = vi.fn(async ({ prompt }) => {
      prompts.push(prompt);
      return 'bounded digest';
    });

    const { app } = makeApp({ role: 'Admin', releaseDigestRunner });
    await request(app)
      .post(`/api/projects/${PROJECT_ID}/deployments/${dep.id}/release-digest`)
      .send({})
      .expect(200);

    expect(prompts[0]).toContain(`"maxReleaseItems": ${RELEASE_DIGEST_ITEM_LIMIT}`);
    expect(prompts[0]).toContain('"omittedReleaseItemCount": 2');
    expect(prompts[0]).toContain('...[truncated]');
    expect(prompts[0]).not.toContain(longDescriptionTail);
    expect(prompts[0]).not.toContain(longSummaryTail);
    expect(prompts[0]).not.toContain('Beyond cap release item');
    expect(prompts[0]).toContain('label-19');
    expect(prompts[0]).not.toContain('label-20');
  });

  it('returns a deterministic empty release digest without invoking the model', async () => {
    const dep = createDeployment({
      projectId: PROJECT_ID,
      environment: 'production',
      ref: 'release-sha',
      status: 'success',
    });
    const internalCardId = insertReleaseCard('release-digest-empty-excluded', PROJECT_ID, {
      title: 'Internal migration',
      labels: 'internal',
    });
    ensureDeploymentReleaseItem({ deploymentId: dep.id, cardId: internalCardId });
    setDeploymentReleaseItemInclusion({
      deploymentId: dep.id,
      cardId: internalCardId,
      inclusionStatus: 'excluded',
      adjustedBy: 'admin-1',
      note: 'operator excluded internal-only work',
    });
    const releaseDigestRunner: ReleaseDigestRunner = vi.fn(async () => 'should not run');

    const { app } = makeApp({ role: 'Admin', releaseDigestRunner });
    const response = await request(app)
      .post(`/api/projects/${PROJECT_ID}/deployments/${dep.id}/release-digest`)
      .send({})
      .expect(200);

    expect(releaseDigestRunner).not.toHaveBeenCalled();
    expect(response.body.digestMarkdown).toBe(EMPTY_RELEASE_DIGEST_MARKDOWN);
  });

  it('redacts sensitive fact text before the model and redacts sensitive model output', async () => {
    const dep = createDeployment({
      projectId: PROJECT_ID,
      environment: 'production',
      ref: 'release-sha',
      status: 'success',
    });
    const ticket = createSupportTicket({
      projectId: PROJECT_ID,
      subject: 'Login export failed',
      body: 'customer bug',
      type: 'bug',
      reporterEmail: 'reporter@example.com',
    });
    recordSupportTicketInvestigation(ticket.id, {
      summary: 'Fixed login export for reporter@example.com after password: hunter2 failed.',
    });
    const cardId = insertReleaseCard('release-digest-redacted', PROJECT_ID, {
      supportTicketId: ticket.id,
      title: 'Fix login export',
      description:
        'Do not leak reporter@example.com, api_key=sk_live_secret, or Authorization: Bearer sk_live_auth.',
    });
    ensureDeploymentReleaseItem({ deploymentId: dep.id, cardId });
    const prompts: string[] = [];
    const releaseDigestRunner: ReleaseDigestRunner = vi.fn(async ({ prompt }) => {
      prompts.push(prompt);
      return [
        '## Release digest',
        '',
        'Fixed login export for reporter@example.com with token=abc123 and Authorization: Bearer sk_live_output.',
      ].join('\n');
    });

    const { app } = makeApp({ role: 'Admin', releaseDigestRunner });
    const response = await request(app)
      .post(`/api/projects/${PROJECT_ID}/deployments/${dep.id}/release-digest`)
      .send({})
      .expect(200);

    expect(prompts[0]).not.toContain('reporter@example.com');
    expect(prompts[0]).not.toContain('sk_live_secret');
    expect(prompts[0]).not.toContain('sk_live_auth');
    expect(prompts[0]).not.toContain('hunter2');
    expect(prompts[0]).toContain('[redacted email]');
    expect(prompts[0]).toContain('api_key=[redacted secret]');
    expect(prompts[0]).toContain('password=[redacted secret]');
    expect(prompts[0]).toContain('authorization=[redacted secret]');
    expect(response.body.digestMarkdown).not.toContain('reporter@example.com');
    expect(response.body.digestMarkdown).not.toContain('abc123');
    expect(response.body.digestMarkdown).not.toContain('sk_live_output');
    expect(response.body.digestMarkdown).toContain('[redacted email]');
    expect(response.body.digestMarkdown).toContain('token=[redacted secret]');
    expect(response.body.digestMarkdown).toContain('authorization=[redacted secret]');
  });

  it('lets Admin include and exclude release items with an audit reason', async () => {
    const dep = createDeployment({
      projectId: PROJECT_ID,
      environment: 'prod',
      ref: 'abc',
      status: 'awaiting_approval',
    });
    const existingCardId = insertReleaseCard('release-card-existing', PROJECT_ID, {
      title: 'Internal cleanup',
    });
    const missedCardId = insertReleaseCard('release-card-missed', PROJECT_ID, {
      title: 'Customer-visible fix',
    });
    ensureDeploymentReleaseItem({ deploymentId: dep.id, cardId: existingCardId });

    const user = makeApp({ role: 'User' });
    await request(user.app)
      .put(`/api/projects/${PROJECT_ID}/deployments/${dep.id}/release-items/${existingCardId}`)
      .send({ inclusionStatus: 'excluded', reason: 'not customer-facing' })
      .expect(403);

    const admin = makeApp({ role: 'Admin' });
    const excluded = await request(admin.app)
      .put(`/api/projects/${PROJECT_ID}/deployments/${dep.id}/release-items/${existingCardId}`)
      .send({ inclusionStatus: 'excluded', reason: 'not customer-facing' })
      .expect(200);
    expect(excluded.body.releaseItem).toMatchObject({
      card_id: existingCardId,
      inclusion_status: 'excluded',
      source: 'operator',
      operator_adjusted_by: 'user-1',
      operator_adjustment_note: 'not customer-facing',
      card: { title: 'Internal cleanup' },
    });
    expect(excluded.body.releaseItem.operator_adjusted_at).toBeTruthy();

    const included = await request(admin.app)
      .put(`/api/projects/${PROJECT_ID}/deployments/${dep.id}/release-items/${missedCardId}`)
      .send({ inclusionStatus: 'included', reason: 'missed by auto detection' })
      .expect(200);
    expect(included.body.releaseItems.map((item: { card_id: string }) => item.card_id)).toEqual([
      existingCardId,
      missedCardId,
    ]);
    expect(included.body.releaseItem).toMatchObject({
      card_id: missedCardId,
      inclusion_status: 'included',
      source: 'operator',
      operator_adjustment_note: 'missed by auto detection',
      card: { title: 'Customer-visible fix' },
    });
  });

  it('rejects release item adjustments after deployment finalization', async () => {
    const dep = createDeployment({
      projectId: PROJECT_ID,
      environment: 'prod',
      ref: 'abc',
      status: 'success',
    });
    const cardId = insertReleaseCard('release-card-finalized', PROJECT_ID);
    ensureDeploymentReleaseItem({ deploymentId: dep.id, cardId });

    const { app } = makeApp({ role: 'Admin' });
    const response = await request(app)
      .put(`/api/projects/${PROJECT_ID}/deployments/${dep.id}/release-items/${cardId}`)
      .send({ inclusionStatus: 'excluded', reason: 'after release' })
      .expect(409);
    expect(response.body.error).toBe(
      'Release items can only be adjusted while deployment approval is pending',
    );
  });

  it('rejects release item adjustments for cards outside the deployment project', async () => {
    const dep = createDeployment({
      projectId: PROJECT_ID,
      environment: 'prod',
      ref: 'abc',
      status: 'awaiting_approval',
    });
    const foreignCardId = insertReleaseCard('release-card-foreign', 'other-project');

    const { app } = makeApp({ role: 'Admin' });
    await request(app)
      .put(`/api/projects/${PROJECT_ID}/deployments/${dep.id}/release-items/${foreignCardId}`)
      .send({ inclusionStatus: 'included', reason: 'wrong project' })
      .expect(404);
  });

  it('rejects release item adjustments with support tickets outside the deployment project', async () => {
    const dep = createDeployment({
      projectId: PROJECT_ID,
      environment: 'prod',
      ref: 'abc',
      status: 'awaiting_approval',
    });
    const cardId = insertReleaseCard('release-card-foreign-ticket', PROJECT_ID);
    const foreignTicket = createSupportTicket({
      projectId: 'other-project',
      body: 'not this project',
    });

    const { app } = makeApp({ role: 'Admin' });
    const response = await request(app)
      .put(`/api/projects/${PROJECT_ID}/deployments/${dep.id}/release-items/${cardId}`)
      .send({
        inclusionStatus: 'included',
        reason: 'wrong ticket project',
        supportTicketId: foreignTicket.id,
      })
      .expect(400);
    expect(response.body.error).toBe(
      `support ticket ${foreignTicket.id} does not belong to the deployment project`,
    );
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

  describe('GET /deploy/environments', () => {
    it('resolves declared environments as active/enabled/deployable with live state', async () => {
      ensureDeploymentEnvironment(PROJECT_ID, 'dev');
      const current = createDeployment({
        projectId: PROJECT_ID,
        environment: 'dev',
        ref: 'current-sha',
        status: 'success',
      });
      setEnvironmentCurrentRef(PROJECT_ID, 'dev', 'current-sha', current.id);

      const { app } = makeApp();
      const res = await request(app)
        .get(`/api/projects/${PROJECT_ID}/deploy/environments`)
        .expect(200);

      expect(res.body).toMatchObject({
        projectId: PROJECT_ID,
        configPath: '.agent-hub/deploy.yaml',
      });
      expect(res.body.environments).toHaveLength(2);
      const dev = res.body.environments.find((e: { name: string }) => e.name === 'dev');
      expect(dev).toMatchObject({
        name: 'dev',
        active: true,
        enabled: true,
        deployable: true,
        approval: false,
        runsOn: 'ubuntu-24.04',
        timeoutMinutes: 60,
        currentRef: 'current-sha',
        currentDeploymentId: current.id,
        lastDeployment: { id: current.id, ref: 'current-sha', status: 'success' },
        config: null,
      });
      expect(dev.steps).toEqual([{ name: 'deploy', run: './deploy-dev.sh' }]);
      // Rollback is out of scope: the resolved view must not carry a rollback target.
      expect(dev).not.toHaveProperty('rollbackTarget');
    });

    it('marks a paused environment as not deployable and surfaces its config row', async () => {
      const config = setEnvironmentEnabled(PROJECT_ID, 'prod', false);
      const { app } = makeApp();
      const res = await request(app)
        .get(`/api/projects/${PROJECT_ID}/deploy/environments`)
        .expect(200);

      const prod = res.body.environments.find((e: { name: string }) => e.name === 'prod');
      expect(prod).toMatchObject({
        name: 'prod',
        active: true,
        enabled: false,
        deployable: false,
        approval: true,
        config: { id: config.id, enabled: false },
      });
    });

    it('surfaces an orphaned config row (env removed from deploy.yaml) as inactive', async () => {
      upsertEnvironmentConfig({
        projectId: PROJECT_ID,
        environmentName: 'legacy',
        enabled: true,
        meta: { note: 'kept for audit' },
      });
      const { app } = makeApp();
      const res = await request(app)
        .get(`/api/projects/${PROJECT_ID}/deploy/environments`)
        .expect(200);

      const legacy = res.body.environments.find((e: { name: string }) => e.name === 'legacy');
      expect(legacy).toMatchObject({
        name: 'legacy',
        active: false,
        enabled: true,
        deployable: false,
        approval: null,
        runsOn: null,
        timeoutMinutes: null,
        steps: [],
        config: { enabled: true, meta: { note: 'kept for audit' } },
      });
    });

    it('returns orphaned config rows with no declared envs when deploy.yaml is missing', async () => {
      upsertEnvironmentConfig({ projectId: PROJECT_ID, environmentName: 'legacy', enabled: false });
      const { app } = makeApp({
        loadConfig: async () => {
          throw new DeployConfigError('not_found', 'deploy.yaml not found');
        },
      });
      const res = await request(app)
        .get(`/api/projects/${PROJECT_ID}/deploy/environments`)
        .expect(200);

      expect(res.body.environments).toHaveLength(1);
      expect(res.body.environments[0]).toMatchObject({
        name: 'legacy',
        active: false,
        deployable: false,
        enabled: false,
      });
    });

    it('returns 400 when deploy.yaml is malformed', async () => {
      const { app } = makeApp({
        loadConfig: async () => {
          throw new DeployConfigError('invalid_yaml', 'deploy.yaml is not valid YAML');
        },
      });
      await request(app).get(`/api/projects/${PROJECT_ID}/deploy/environments`).expect(400);
    });

    it('returns 404 for an unknown project', async () => {
      const { app } = makeApp();
      await request(app).get('/api/projects/missing/deploy/environments').expect(404);
    });
  });

  describe('PATCH /deploy/environments/:environmentName', () => {
    it('disables a declared environment and reflects it in the resolved list', async () => {
      const { app } = makeApp();
      const res = await request(app)
        .patch(`/api/projects/${PROJECT_ID}/deploy/environments/prod`)
        .send({ enabled: false })
        .expect(200);

      const prod = res.body.environments.find((e: { name: string }) => e.name === 'prod');
      expect(prod).toMatchObject({
        name: 'prod',
        active: true,
        enabled: false,
        deployable: false,
        config: { enabled: false },
      });
      // The write persisted to the runtime config store.
      expect(getEnvironmentConfig(PROJECT_ID, 'prod')?.enabled).toBe(0);
    });

    it('re-enables a paused environment, preserving other envs', async () => {
      setEnvironmentEnabled(PROJECT_ID, 'prod', false);
      const { app } = makeApp();
      const res = await request(app)
        .patch(`/api/projects/${PROJECT_ID}/deploy/environments/prod`)
        .send({ enabled: true })
        .expect(200);

      const prod = res.body.environments.find((e: { name: string }) => e.name === 'prod');
      expect(prod).toMatchObject({ enabled: true, deployable: true });
      const dev = res.body.environments.find((e: { name: string }) => e.name === 'dev');
      expect(dev).toMatchObject({ enabled: true });
    });

    it('can pause an orphaned config row (env removed from deploy.yaml)', async () => {
      upsertEnvironmentConfig({ projectId: PROJECT_ID, environmentName: 'legacy', enabled: true });
      const { app } = makeApp();
      const res = await request(app)
        .patch(`/api/projects/${PROJECT_ID}/deploy/environments/legacy`)
        .send({ enabled: false })
        .expect(200);

      const legacy = res.body.environments.find((e: { name: string }) => e.name === 'legacy');
      expect(legacy).toMatchObject({ name: 'legacy', active: false, enabled: false });
    });

    it('returns 404 for an environment that is neither declared nor configured', async () => {
      const { app } = makeApp();
      await request(app)
        .patch(`/api/projects/${PROJECT_ID}/deploy/environments/ghost`)
        .send({ enabled: false })
        .expect(404);
      // No junk config row was created for the typo.
      expect(getEnvironmentConfig(PROJECT_ID, 'ghost')).toBeNull();
    });

    it('returns 400 when enabled is missing or not a boolean', async () => {
      const { app } = makeApp();
      await request(app)
        .patch(`/api/projects/${PROJECT_ID}/deploy/environments/prod`)
        .send({ enabled: 'nope' })
        .expect(400);
    });

    it('returns 403 when the caller is not an Admin', async () => {
      const { app } = makeApp({ role: 'User' });
      await request(app)
        .patch(`/api/projects/${PROJECT_ID}/deploy/environments/prod`)
        .send({ enabled: false })
        .expect(403);
    });

    it('returns 404 for an unknown project', async () => {
      const { app } = makeApp();
      await request(app)
        .patch('/api/projects/missing/deploy/environments/prod')
        .send({ enabled: false })
        .expect(404);
    });
  });

  describe('DELETE /deploy/environments/:environmentName', () => {
    it('removes an orphaned config row and drops it from the resolved list', async () => {
      upsertEnvironmentConfig({ projectId: PROJECT_ID, environmentName: 'legacy', enabled: false });
      const { app } = makeApp();
      const res = await request(app)
        .delete(`/api/projects/${PROJECT_ID}/deploy/environments/legacy`)
        .expect(200);

      expect(res.body.removed).toBe(true);
      expect(res.body.environments.some((e: { name: string }) => e.name === 'legacy')).toBe(false);
      expect(getEnvironmentConfig(PROJECT_ID, 'legacy')).toBeNull();
    });

    it('resets a declared environment to the enabled default', async () => {
      setEnvironmentEnabled(PROJECT_ID, 'prod', false);
      const { app } = makeApp();
      const res = await request(app)
        .delete(`/api/projects/${PROJECT_ID}/deploy/environments/prod`)
        .expect(200);

      expect(res.body.removed).toBe(true);
      const prod = res.body.environments.find((e: { name: string }) => e.name === 'prod');
      // Still declared, so present; config row gone means default-enabled again.
      expect(prod).toMatchObject({ name: 'prod', active: true, enabled: true, config: null });
    });

    it('is idempotent: removed=false when there is no config row', async () => {
      const { app } = makeApp();
      const res = await request(app)
        .delete(`/api/projects/${PROJECT_ID}/deploy/environments/prod`)
        .expect(200);
      expect(res.body.removed).toBe(false);
    });

    it('returns 403 when the caller is not an Admin', async () => {
      const { app } = makeApp({ role: 'User' });
      await request(app).delete(`/api/projects/${PROJECT_ID}/deploy/environments/prod`).expect(403);
    });

    it('returns 404 for an unknown project', async () => {
      const { app } = makeApp();
      await request(app).delete('/api/projects/missing/deploy/environments/prod').expect(404);
    });
  });

  describe('deploy triggers CRUD', () => {
    const triggersUrl = (env: string) =>
      `/api/projects/${PROJECT_ID}/deploy/environments/${env}/triggers`;

    describe('GET .../triggers', () => {
      it('lists triggers for an environment', async () => {
        createTrigger({
          projectId: PROJECT_ID,
          environmentName: 'prod',
          event: 'push',
          branchPattern: 'main',
        });
        const { app } = makeApp();
        const res = await request(app).get(triggersUrl('prod')).expect(200);
        expect(res.body).toMatchObject({ projectId: PROJECT_ID, environmentName: 'prod' });
        expect(res.body.triggers).toHaveLength(1);
        expect(res.body.triggers[0]).toMatchObject({
          event: 'push',
          branchPattern: 'main',
          enabled: true,
        });
      });

      it('returns an empty list for an environment with no triggers', async () => {
        const { app } = makeApp();
        const res = await request(app).get(triggersUrl('dev')).expect(200);
        expect(res.body.triggers).toEqual([]);
      });

      it('returns 404 for an unknown project', async () => {
        const { app } = makeApp();
        await request(app)
          .get('/api/projects/missing/deploy/environments/prod/triggers')
          .expect(404);
      });
    });

    describe('POST .../triggers', () => {
      it('creates a trigger on a declared environment', async () => {
        const { app } = makeApp();
        const res = await request(app)
          .post(triggersUrl('prod'))
          .send({ event: 'push', branchPattern: 'main' })
          .expect(201);
        expect(res.body.trigger).toMatchObject({
          environmentName: 'prod',
          event: 'push',
          branchPattern: 'main',
          enabled: true,
        });
        expect(listTriggersForEnvironment(PROJECT_ID, 'prod')).toHaveLength(1);
      });

      it('allows creating a trigger on an orphaned (configured) environment', async () => {
        upsertEnvironmentConfig({
          projectId: PROJECT_ID,
          environmentName: 'legacy',
          enabled: true,
        });
        const { app } = makeApp();
        await request(app)
          .post(triggersUrl('legacy'))
          .send({ event: 'merge', branchPattern: 'release/*' })
          .expect(201);
      });

      it('returns 404 for an environment neither declared nor configured', async () => {
        const { app } = makeApp();
        await request(app)
          .post(triggersUrl('ghost'))
          .send({ event: 'push', branchPattern: 'main' })
          .expect(404);
        expect(listTriggersForEnvironment(PROJECT_ID, 'ghost')).toHaveLength(0);
      });

      it('returns 409 on a duplicate (event, branchPattern)', async () => {
        const { app } = makeApp();
        await request(app)
          .post(triggersUrl('prod'))
          .send({ event: 'push', branchPattern: 'main' })
          .expect(201);
        await request(app)
          .post(triggersUrl('prod'))
          .send({ event: 'push', branchPattern: 'main' })
          .expect(409);
      });

      it('returns 400 for an invalid event or missing branchPattern', async () => {
        const { app } = makeApp();
        await request(app)
          .post(triggersUrl('prod'))
          .send({ event: 'tag', branchPattern: 'main' })
          .expect(400);
        await request(app).post(triggersUrl('prod')).send({ event: 'push' }).expect(400);
      });

      it('returns 403 when the caller is not an Admin', async () => {
        const { app } = makeApp({ role: 'User' });
        await request(app)
          .post(triggersUrl('prod'))
          .send({ event: 'push', branchPattern: 'main' })
          .expect(403);
      });
    });

    describe('PATCH .../triggers/:triggerId', () => {
      it('updates a trigger', async () => {
        const row = createTrigger({
          projectId: PROJECT_ID,
          environmentName: 'prod',
          event: 'push',
          branchPattern: 'main',
        });
        const { app } = makeApp();
        const res = await request(app)
          .patch(`${triggersUrl('prod')}/${row.id}`)
          .send({ enabled: false, branchPattern: 'release/*' })
          .expect(200);
        expect(res.body.trigger).toMatchObject({ enabled: false, branchPattern: 'release/*' });
      });

      it('returns 404 for a missing trigger', async () => {
        const { app } = makeApp();
        await request(app)
          .patch(`${triggersUrl('prod')}/nope`)
          .send({ enabled: false })
          .expect(404);
      });

      it('returns 400 for an empty body', async () => {
        const row = createTrigger({
          projectId: PROJECT_ID,
          environmentName: 'prod',
          event: 'push',
          branchPattern: 'main',
        });
        const { app } = makeApp();
        await request(app)
          .patch(`${triggersUrl('prod')}/${row.id}`)
          .send({})
          .expect(400);
      });

      it('returns 409 when an update collides with another trigger', async () => {
        createTrigger({
          projectId: PROJECT_ID,
          environmentName: 'prod',
          event: 'push',
          branchPattern: 'main',
        });
        const b = createTrigger({
          projectId: PROJECT_ID,
          environmentName: 'prod',
          event: 'push',
          branchPattern: 'develop',
        });
        const { app } = makeApp();
        await request(app)
          .patch(`${triggersUrl('prod')}/${b.id}`)
          .send({ branchPattern: 'main' })
          .expect(409);
      });

      it('returns 403 when the caller is not an Admin', async () => {
        const row = createTrigger({
          projectId: PROJECT_ID,
          environmentName: 'prod',
          event: 'push',
          branchPattern: 'main',
        });
        const { app } = makeApp({ role: 'User' });
        await request(app)
          .patch(`${triggersUrl('prod')}/${row.id}`)
          .send({ enabled: false })
          .expect(403);
      });
    });

    describe('DELETE .../triggers/:triggerId', () => {
      it('removes a trigger', async () => {
        const row = createTrigger({
          projectId: PROJECT_ID,
          environmentName: 'prod',
          event: 'push',
          branchPattern: 'main',
        });
        const { app } = makeApp();
        const res = await request(app)
          .delete(`${triggersUrl('prod')}/${row.id}`)
          .expect(200);
        expect(res.body).toEqual({ removed: true });
        expect(listTriggersForEnvironment(PROJECT_ID, 'prod')).toHaveLength(0);
      });

      it('returns 404 for a missing trigger', async () => {
        const { app } = makeApp();
        await request(app)
          .delete(`${triggersUrl('prod')}/nope`)
          .expect(404);
      });

      it('returns 403 when the caller is not an Admin', async () => {
        const row = createTrigger({
          projectId: PROJECT_ID,
          environmentName: 'prod',
          event: 'push',
          branchPattern: 'main',
        });
        const { app } = makeApp({ role: 'User' });
        await request(app)
          .delete(`${triggersUrl('prod')}/${row.id}`)
          .expect(403);
      });
    });
  });

  describe('deploy schedules CRUD', () => {
    const CRON = '0 3 * * *';
    const schedulesUrl = (env: string) =>
      `/api/projects/${PROJECT_ID}/deploy/environments/${env}/schedules`;

    describe('GET .../schedules', () => {
      it('lists schedules for an environment', async () => {
        createSchedule({
          projectId: PROJECT_ID,
          environmentName: 'prod',
          ref: 'main',
          cron: CRON,
        });
        const { app } = makeApp();
        const res = await request(app).get(schedulesUrl('prod')).expect(200);
        expect(res.body).toMatchObject({ projectId: PROJECT_ID, environmentName: 'prod' });
        expect(res.body.schedules).toHaveLength(1);
        expect(res.body.schedules[0]).toMatchObject({
          ref: 'main',
          cron: CRON,
          enabled: true,
        });
      });

      it('returns an empty list for an environment with no schedules', async () => {
        const { app } = makeApp();
        const res = await request(app).get(schedulesUrl('dev')).expect(200);
        expect(res.body.schedules).toEqual([]);
      });

      it('returns 404 for an unknown project', async () => {
        const { app } = makeApp();
        await request(app)
          .get('/api/projects/missing/deploy/environments/prod/schedules')
          .expect(404);
      });
    });

    describe('POST .../schedules', () => {
      it('creates a schedule on a declared environment and captures the caller as owner', async () => {
        const { app } = makeApp();
        const res = await request(app)
          .post(schedulesUrl('prod'))
          .send({ ref: 'main', cron: CRON, timezone: 'America/New_York' })
          .expect(201);
        expect(res.body.schedule).toMatchObject({
          environmentName: 'prod',
          ref: 'main',
          cron: CRON,
          timezone: 'America/New_York',
          ownerUserId: 'user-1',
          enabled: true,
        });
        expect(listSchedulesForEnvironment(PROJECT_ID, 'prod')).toHaveLength(1);
      });

      it('allows creating a schedule on an orphaned (configured) environment', async () => {
        upsertEnvironmentConfig({
          projectId: PROJECT_ID,
          environmentName: 'legacy',
          enabled: true,
        });
        const { app } = makeApp();
        await request(app)
          .post(schedulesUrl('legacy'))
          .send({ ref: 'main', cron: CRON })
          .expect(201);
      });

      it('returns 404 for an environment neither declared nor configured', async () => {
        const { app } = makeApp();
        await request(app)
          .post(schedulesUrl('ghost'))
          .send({ ref: 'main', cron: CRON })
          .expect(404);
        expect(listSchedulesForEnvironment(PROJECT_ID, 'ghost')).toHaveLength(0);
      });

      it('returns 409 on a duplicate (ref, cron)', async () => {
        const { app } = makeApp();
        await request(app).post(schedulesUrl('prod')).send({ ref: 'main', cron: CRON }).expect(201);
        await request(app).post(schedulesUrl('prod')).send({ ref: 'main', cron: CRON }).expect(409);
      });

      it('returns 400 for an invalid cron or missing ref', async () => {
        const { app } = makeApp();
        await request(app)
          .post(schedulesUrl('prod'))
          .send({ ref: 'main', cron: 'not-a-cron' })
          .expect(400);
        await request(app).post(schedulesUrl('prod')).send({ cron: CRON }).expect(400);
      });

      it('returns 400 for an invalid timezone', async () => {
        const { app } = makeApp();
        await request(app)
          .post(schedulesUrl('prod'))
          .send({ ref: 'main', cron: CRON, timezone: 'Mars/Phobos' })
          .expect(400);
      });

      it('returns 403 when the caller is not an Admin', async () => {
        const { app } = makeApp({ role: 'User' });
        await request(app).post(schedulesUrl('prod')).send({ ref: 'main', cron: CRON }).expect(403);
      });
    });

    describe('PATCH .../schedules/:scheduleId', () => {
      it('updates a schedule', async () => {
        const row = createSchedule({
          projectId: PROJECT_ID,
          environmentName: 'prod',
          ref: 'main',
          cron: CRON,
        });
        const { app } = makeApp();
        const res = await request(app)
          .patch(`${schedulesUrl('prod')}/${row.id}`)
          .send({ enabled: false, cron: '0 4 * * *' })
          .expect(200);
        expect(res.body.schedule).toMatchObject({ enabled: false, cron: '0 4 * * *' });
      });

      it('returns 404 for a missing schedule', async () => {
        const { app } = makeApp();
        await request(app)
          .patch(`${schedulesUrl('prod')}/nope`)
          .send({ enabled: false })
          .expect(404);
      });

      it('returns 400 for an empty body', async () => {
        const row = createSchedule({
          projectId: PROJECT_ID,
          environmentName: 'prod',
          ref: 'main',
          cron: CRON,
        });
        const { app } = makeApp();
        await request(app)
          .patch(`${schedulesUrl('prod')}/${row.id}`)
          .send({})
          .expect(400);
      });

      it('returns 409 when an update collides with another schedule', async () => {
        createSchedule({
          projectId: PROJECT_ID,
          environmentName: 'prod',
          ref: 'main',
          cron: CRON,
        });
        const b = createSchedule({
          projectId: PROJECT_ID,
          environmentName: 'prod',
          ref: 'develop',
          cron: CRON,
        });
        const { app } = makeApp();
        await request(app)
          .patch(`${schedulesUrl('prod')}/${b.id}`)
          .send({ ref: 'main' })
          .expect(409);
      });

      it('returns 403 when the caller is not an Admin', async () => {
        const row = createSchedule({
          projectId: PROJECT_ID,
          environmentName: 'prod',
          ref: 'main',
          cron: CRON,
        });
        const { app } = makeApp({ role: 'User' });
        await request(app)
          .patch(`${schedulesUrl('prod')}/${row.id}`)
          .send({ enabled: false })
          .expect(403);
      });
    });

    describe('DELETE .../schedules/:scheduleId', () => {
      it('removes a schedule', async () => {
        const row = createSchedule({
          projectId: PROJECT_ID,
          environmentName: 'prod',
          ref: 'main',
          cron: CRON,
        });
        const { app } = makeApp();
        const res = await request(app)
          .delete(`${schedulesUrl('prod')}/${row.id}`)
          .expect(200);
        expect(res.body).toEqual({ removed: true });
        expect(listSchedulesForEnvironment(PROJECT_ID, 'prod')).toHaveLength(0);
      });

      it('returns 404 for a missing schedule', async () => {
        const { app } = makeApp();
        await request(app)
          .delete(`${schedulesUrl('prod')}/nope`)
          .expect(404);
      });

      it('returns 403 when the caller is not an Admin', async () => {
        const row = createSchedule({
          projectId: PROJECT_ID,
          environmentName: 'prod',
          ref: 'main',
          cron: CRON,
        });
        const { app } = makeApp({ role: 'User' });
        await request(app)
          .delete(`${schedulesUrl('prod')}/${row.id}`)
          .expect(403);
      });
    });
  });

  describe('GET .../deploy/release-gate-candidates', () => {
    const candidatesUrl = `/api/projects/${PROJECT_ID}/deploy/release-gate-candidates`;

    // Seed a board for PROJECT_ID with the given cards, plus a `sessions` row
    // for each id in `liveSessions`. Cards reference the shared column set so a
    // single To Do / Done / Cancelled classification drives the filter.
    function seedBoard(
      cards: { session_id: string | null; title: string; column: 'todo' | 'done' | 'cancel' }[],
      liveSessions: string[],
    ) {
      const db = getDb();
      const boardId = 'cand-board';
      db.prepare('INSERT INTO kanban_boards (id, project_id, name) VALUES (?, ?, ?)').run(
        boardId,
        PROJECT_ID,
        'Board',
      );
      const columns: Record<string, string> = { todo: 'To Do', done: 'Done', cancel: 'Cancelled' };
      let pos = 0;
      for (const [key, name] of Object.entries(columns)) {
        db.prepare(
          'INSERT INTO kanban_columns (id, board_id, name, position) VALUES (?, ?, ?, ?)',
        ).run(`cand-col-${key}`, boardId, name, pos++);
      }
      for (const sid of liveSessions) {
        db.prepare('INSERT OR REPLACE INTO sessions (id, agent_id, name) VALUES (?, ?, ?)').run(
          sid,
          'agent-1',
          `Session ${sid}`,
        );
      }
      cards.forEach((card, i) => {
        db.prepare(
          'INSERT INTO kanban_cards (id, column_id, board_id, title, session_id, position) VALUES (?, ?, ?, ?, ?, ?)',
        ).run(`cand-card-${i}`, `cand-col-${card.column}`, boardId, card.title, card.session_id, i);
      });
    }

    it('returns live sessions, dropping those on terminal (Done/Cancelled) cards', async () => {
      // Candidates are sourced from the project's live sessions (sidebar
      // parity), not from cards. A card on a Done/Cancelled column drops its
      // session; a card referencing a non-existent session (sess-gone) never
      // appears because there is no live session to enumerate. Labels come from
      // the session name.
      seedBoard(
        [
          { session_id: 'sess-live', title: 'Fix auth', column: 'todo' },
          { session_id: 'sess-gone', title: 'Purged session', column: 'todo' },
          { session_id: 'sess-done', title: 'Old work', column: 'done' },
          { session_id: 'sess-cancel', title: 'Dropped', column: 'cancel' },
          { session_id: null, title: 'No session', column: 'todo' },
        ],
        ['sess-live', 'sess-done', 'sess-cancel'],
      );
      const { app } = makeApp();
      const res = await request(app).get(candidatesUrl).expect(200);
      expect(res.body).toMatchObject({ projectId: PROJECT_ID });
      expect(res.body.sessions).toEqual([{ id: 'sess-live', label: 'Session sess-live' }]);
    });

    it('offers live sessions even when the project has no board', async () => {
      // No board → no terminal filtering, but live sessions are still offered.
      getDb()
        .prepare('INSERT OR REPLACE INTO sessions (id, agent_id, name) VALUES (?, ?, ?)')
        .run('sess-boardless', 'agent-1', 'Ad-hoc thread');
      const { app } = makeApp();
      const res = await request(app).get(candidatesUrl).expect(200);
      expect(res.body).toEqual({
        projectId: PROJECT_ID,
        sessions: [{ id: 'sess-boardless', label: 'Ad-hoc thread' }],
      });
    });

    it('returns 404 for an unknown project', async () => {
      const { app } = makeApp();
      await request(app).get('/api/projects/missing/deploy/release-gate-candidates').expect(404);
    });
  });

  describe('release gates CRUD', () => {
    const gatesUrl = (env: string) =>
      `/api/projects/${PROJECT_ID}/deploy/environments/${env}/release-gates`;

    describe('GET .../release-gates', () => {
      it('lists gates with live completion progress', async () => {
        createReleaseGate({
          projectId: PROJECT_ID,
          environmentName: 'prod',
          sessionIds: ['sess-a', 'sess-b'],
        });
        const { app } = makeApp();
        const res = await request(app).get(gatesUrl('prod')).expect(200);
        expect(res.body).toMatchObject({ projectId: PROJECT_ID, environmentName: 'prod' });
        expect(res.body.gates).toHaveLength(1);
        expect(res.body.gates[0]).toMatchObject({
          status: 'armed',
          enabled: true,
          ref: 'main',
          sessionIds: ['sess-a', 'sess-b'],
        });
        // Neither session exists in the DB → both missing → blocked, not satisfied.
        expect(res.body.gates[0].progress).toMatchObject({
          sessionsTotal: 2,
          sessionsComplete: 0,
          blocked: true,
          satisfied: false,
        });
      });

      it('returns an empty list for an environment with no gates', async () => {
        const { app } = makeApp();
        const res = await request(app).get(gatesUrl('dev')).expect(200);
        expect(res.body.gates).toEqual([]);
      });

      it('returns 404 for an unknown project', async () => {
        const { app } = makeApp();
        await request(app)
          .get('/api/projects/missing/deploy/environments/prod/release-gates')
          .expect(404);
      });
    });

    describe('POST .../release-gates', () => {
      it('creates a gate on a declared env and captures the caller as owner', async () => {
        const { app } = makeApp();
        const res = await request(app)
          .post(gatesUrl('prod'))
          .send({ sessionIds: ['sess-a'], epicIds: ['epic-1'] })
          .expect(201);
        expect(res.body.gate).toMatchObject({
          environmentName: 'prod',
          ref: 'main',
          sessionIds: ['sess-a'],
          epicIds: ['epic-1'],
          ownerUserId: 'user-1',
          status: 'armed',
          enabled: true,
        });
        expect(listReleaseGatesForEnvironment(PROJECT_ID, 'prod')).toHaveLength(1);
      });

      it('honors a ref override', async () => {
        const { app } = makeApp();
        const res = await request(app)
          .post(gatesUrl('prod'))
          .send({ ref: 'release-1.2', epicIds: ['epic-1'] })
          .expect(201);
        expect(res.body.gate.ref).toBe('release-1.2');
      });

      it('allows creating a gate on an orphaned (configured) environment', async () => {
        upsertEnvironmentConfig({
          projectId: PROJECT_ID,
          environmentName: 'legacy',
          enabled: true,
        });
        const { app } = makeApp();
        await request(app)
          .post(gatesUrl('legacy'))
          .send({ sessionIds: ['sess-a'] })
          .expect(201);
      });

      it('returns 404 for an environment neither declared nor configured', async () => {
        const { app } = makeApp();
        await request(app)
          .post(gatesUrl('ghost'))
          .send({ sessionIds: ['sess-a'] })
          .expect(404);
        expect(listReleaseGatesForEnvironment(PROJECT_ID, 'ghost')).toHaveLength(0);
      });

      it('returns 400 when the gate watches nothing', async () => {
        const { app } = makeApp();
        await request(app).post(gatesUrl('prod')).send({ sessionIds: [], epicIds: [] }).expect(400);
        await request(app).post(gatesUrl('prod')).send({}).expect(400);
      });

      it('returns 403 when the caller is not an Admin', async () => {
        const { app } = makeApp({ role: 'User' });
        await request(app)
          .post(gatesUrl('prod'))
          .send({ sessionIds: ['sess-a'] })
          .expect(403);
      });
    });

    describe('PATCH .../release-gates/:gateId', () => {
      it('updates a gate (pause + re-scope)', async () => {
        const row = createReleaseGate({
          projectId: PROJECT_ID,
          environmentName: 'prod',
          sessionIds: ['sess-a'],
        });
        const { app } = makeApp();
        const res = await request(app)
          .patch(`${gatesUrl('prod')}/${row.id}`)
          .send({ enabled: false, epicIds: ['epic-9'] })
          .expect(200);
        expect(res.body.gate).toMatchObject({
          enabled: false,
          sessionIds: ['sess-a'],
          epicIds: ['epic-9'],
        });
      });

      it('returns 400 when an update would leave the gate watching nothing', async () => {
        const row = createReleaseGate({
          projectId: PROJECT_ID,
          environmentName: 'prod',
          sessionIds: ['sess-a'],
        });
        const { app } = makeApp();
        await request(app)
          .patch(`${gatesUrl('prod')}/${row.id}`)
          .send({ sessionIds: [], epicIds: [] })
          .expect(400);
      });

      it('returns 404 for a missing gate', async () => {
        const { app } = makeApp();
        await request(app)
          .patch(`${gatesUrl('prod')}/nope`)
          .send({ enabled: false })
          .expect(404);
      });

      it('returns 403 when the caller is not an Admin', async () => {
        const row = createReleaseGate({
          projectId: PROJECT_ID,
          environmentName: 'prod',
          sessionIds: ['sess-a'],
        });
        const { app } = makeApp({ role: 'User' });
        await request(app)
          .patch(`${gatesUrl('prod')}/${row.id}`)
          .send({ enabled: false })
          .expect(403);
      });
    });

    describe('DELETE .../release-gates/:gateId', () => {
      it('deletes a gate', async () => {
        const row = createReleaseGate({
          projectId: PROJECT_ID,
          environmentName: 'prod',
          sessionIds: ['sess-a'],
        });
        const { app } = makeApp();
        await request(app)
          .delete(`${gatesUrl('prod')}/${row.id}`)
          .expect(200);
        expect(listReleaseGatesForEnvironment(PROJECT_ID, 'prod')).toHaveLength(0);
      });

      it('returns 404 for a missing gate', async () => {
        const { app } = makeApp();
        await request(app)
          .delete(`${gatesUrl('prod')}/nope`)
          .expect(404);
      });

      it('returns 403 when the caller is not an Admin', async () => {
        const row = createReleaseGate({
          projectId: PROJECT_ID,
          environmentName: 'prod',
          sessionIds: ['sess-a'],
        });
        const { app } = makeApp({ role: 'User' });
        await request(app)
          .delete(`${gatesUrl('prod')}/${row.id}`)
          .expect(403);
      });
    });
  });

  describe('notification routing', () => {
    const routingUrl = (env: string) =>
      `/api/projects/${PROJECT_ID}/deploy/environments/${env}/notification-routing`;

    describe('GET .../notification-routing', () => {
      it('resolves the prod default (reporter + digest) when no override is saved', async () => {
        const { app } = makeApp();
        const res = await request(app).get(routingUrl('prod')).expect(200);
        expect(res.body).toMatchObject({ projectId: PROJECT_ID });
        expect(res.body.routing).toMatchObject({
          environmentName: 'prod',
          isProduction: true,
          ticketReleaseEnabled: true,
          releaseDigestEnabled: true,
          isDefault: true,
          updatedAt: null,
        });
      });

      it('resolves the non-prod default (nothing) when no override is saved', async () => {
        const { app } = makeApp();
        const res = await request(app).get(routingUrl('dev')).expect(200);
        expect(res.body.routing).toMatchObject({
          isProduction: false,
          ticketReleaseEnabled: false,
          releaseDigestEnabled: false,
          isDefault: true,
        });
      });

      it('reflects a saved override', async () => {
        upsertNotificationRouting({
          projectId: PROJECT_ID,
          environmentName: 'dev',
          ticketReleaseEnabled: false,
          releaseDigestEnabled: true,
        });
        const { app } = makeApp();
        const res = await request(app).get(routingUrl('dev')).expect(200);
        expect(res.body.routing).toMatchObject({
          releaseDigestEnabled: true,
          ticketReleaseEnabled: false,
          isDefault: false,
        });
        expect(res.body.routing.updatedAt).toEqual(expect.any(String));
      });

      it('returns 404 for an unknown project', async () => {
        const { app } = makeApp();
        await request(app)
          .get('/api/projects/missing/deploy/environments/prod/notification-routing')
          .expect(404);
      });
    });

    describe('PUT .../notification-routing', () => {
      it('saves an override on a declared environment', async () => {
        const { app } = makeApp();
        const res = await request(app)
          .put(routingUrl('dev'))
          .send({ ticketReleaseEnabled: true, releaseDigestEnabled: true })
          .expect(200);
        expect(res.body.routing).toMatchObject({
          environmentName: 'dev',
          ticketReleaseEnabled: true,
          releaseDigestEnabled: true,
          isDefault: false,
        });
        expect(getNotificationRouting(PROJECT_ID, 'dev')).toMatchObject({
          ticket_release_enabled: 1,
          release_digest_enabled: 1,
        });
      });

      it('partial-updates: flipping one type preserves the other', async () => {
        upsertNotificationRouting({
          projectId: PROJECT_ID,
          environmentName: 'prod',
          ticketReleaseEnabled: true,
          releaseDigestEnabled: true,
        });
        const { app } = makeApp();
        const res = await request(app)
          .put(routingUrl('prod'))
          .send({ releaseDigestEnabled: false })
          .expect(200);
        expect(res.body.routing).toMatchObject({
          ticketReleaseEnabled: true,
          releaseDigestEnabled: false,
        });
      });

      it('allows an override on an orphaned (configured) environment', async () => {
        upsertEnvironmentConfig({
          projectId: PROJECT_ID,
          environmentName: 'legacy',
          enabled: true,
        });
        const { app } = makeApp();
        await request(app)
          .put(routingUrl('legacy'))
          .send({ ticketReleaseEnabled: true })
          .expect(200);
      });

      it('returns 404 for an environment neither declared nor configured', async () => {
        const { app } = makeApp();
        await request(app)
          .put(routingUrl('ghost'))
          .send({ ticketReleaseEnabled: true })
          .expect(404);
        expect(getNotificationRouting(PROJECT_ID, 'ghost')).toBeNull();
      });

      it('returns 400 for an empty body', async () => {
        const { app } = makeApp();
        await request(app).put(routingUrl('prod')).send({}).expect(400);
      });

      it('returns 403 when the caller is not an Admin', async () => {
        const { app } = makeApp({ role: 'User' });
        await request(app).put(routingUrl('prod')).send({ ticketReleaseEnabled: true }).expect(403);
      });
    });
  });
});
