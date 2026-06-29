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
  ensureDeploymentReleaseItem,
  getDeploymentEnvironment,
  listDeploymentApprovals,
  listDeploymentSteps,
  setEnvironmentCurrentRef,
  setDeploymentReleaseItemInclusion,
  updateDeploymentStatus,
} from '../deploy/deployment-store.js';
import { loadDeployConfig, parseDeployConfig, type DeployConfig } from '../deploy/deploy-config.js';
import { createSupportTicket, recordSupportTicketInvestigation } from '../support-tickets-store.js';
import { updateReleaseNotificationSettings } from '../release-notification-settings.js';
import {
  enqueueReleaseNotificationOutbox,
  markReleaseNotificationOutboxError,
} from '../release-notification-outbox.js';
import {
  EMPTY_RELEASE_DIGEST_MARKDOWN,
  RELEASE_DIGEST_ITEM_LIMIT,
  RELEASE_DIGEST_TEXT_FIELD_MAX_BYTES,
  type ReleaseDigestRunner,
} from '../release-digest.js';
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
      orchestratorDeps: { runnerBackend: backend.backend, env: { PATH: '/usr/bin' } },
      releaseDigestRunner: opts.releaseDigestRunner,
    }),
  );
  return { app, backend, deps, sessions, messages };
}

beforeEach(() => {
  const db = getDb();
  db.exec('DELETE FROM deployment_release_items;');
  db.exec('DELETE FROM deployment_approvals;');
  db.exec('DELETE FROM deployment_steps;');
  db.exec('DELETE FROM release_notification_outbox;');
  db.exec('DELETE FROM deployments;');
  db.exec('DELETE FROM deployment_environments;');
  db.exec('DELETE FROM release_notification_settings;');
  db.exec('DELETE FROM kanban_cards;');
  db.exec('DELETE FROM kanban_columns;');
  db.exec('DELETE FROM kanban_boards;');
  db.exec('DELETE FROM support_tickets;');
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
  groups: Array<{ key: string; label: string; itemIndexes: number[] }>;
  factLimits: { excludedReleaseItemCount: number };
} {
  const marker = 'Generate the release digest from this JSON facts object only:\n';
  const start = prompt.indexOf(marker);
  expect(start).toBeGreaterThanOrEqual(0);
  const jsonStart = start + marker.length;
  const jsonEnd = prompt.indexOf('\n\nReturn a customer-facing markdown email body.', jsonStart);
  expect(jsonEnd).toBeGreaterThan(jsonStart);
  return JSON.parse(prompt.slice(jsonStart, jsonEnd)) as {
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

    const { app } = makeApp();
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
    const facts = extractReleaseDigestFacts(prompts[0]);
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
});
