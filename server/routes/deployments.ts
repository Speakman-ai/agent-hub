import path from 'path';
import { rm } from 'fs/promises';
import { Router, type Request, type Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import type { AuthenticatedRequest } from '../auth.js';
import { requireRole, type Role } from '../roles.js';
import { resolveEffectiveModel } from '../effective-model.js';
import { resolveOwnerUserId, setSessionOwner } from '../session-ownership.js';
import { agentAcceptsAutonomousTickets } from '../agent-autonomy.js';
import type {
  Agent,
  DeploymentApprovalRow,
  DeploymentRow,
  DeploymentStepRow,
  Project,
  RouteDeps,
  SessionRow,
} from '../types.js';
import {
  DeployConfigError,
  loadDeployConfig,
  type DeployConfig,
  type DeployEnvironmentConfig,
} from '../deploy/deploy-config.js';
import {
  approveDeployment,
  cancelDeployment,
  DeploymentApprovalError,
  DeploymentCancelError,
  EnvironmentBusyError,
  triggerDeployment,
  type DeployOrchestratorDeps,
} from '../deploy/deploy-orchestrator.js';
import {
  getDeployment,
  getDeploymentEnvironment,
  listDeploymentApprovals,
  listDeployments,
  listDeploymentsForEnvironment,
  listDeploymentSteps,
} from '../deploy/deployment-store.js';
import {
  DeploymentCheckoutError,
  prepareDeploymentCheckout,
} from '../deploy/deployment-checkout.js';
import {
  ApproveDeploymentRequestSchema,
  CancelDeploymentRequestSchema,
  DeploymentListQuerySchema,
  RollbackDeploymentRequestSchema,
  TriggerDeploymentRequestSchema,
} from './deployments.openapi.js';

type CheckoutResult = { worktreePath: string; resolvedRef: string };

interface DeploymentRouteOptions {
  prepareCheckout?: (args: { project: Project; ref: string }) => Promise<CheckoutResult>;
  loadConfig?: (deployYamlPath: string) => Promise<DeployConfig>;
  orchestratorDeps?: Partial<DeployOrchestratorDeps>;
}

function parseMeta(meta: string | null): unknown | null {
  if (!meta) return null;
  try {
    return JSON.parse(meta);
  } catch {
    return meta;
  }
}

function deploymentDto(row: DeploymentRow): Record<string, unknown> {
  return { ...row, meta: parseMeta(row.meta) };
}

function nullableDeploymentDto(
  row: DeploymentRow | null | undefined,
): Record<string, unknown> | null {
  return row ? deploymentDto(row) : null;
}

function projectDeployYamlPath(project: Project): string {
  return path.join(project.cwd, '.agent-hub', 'deploy.yaml');
}

function pickWizardAgent(project: Project): string | null {
  if (!project.agents || !Array.isArray(project.agents) || project.agents.length === 0) {
    return null;
  }
  const codingAgent = project.agents.find((agent) => {
    if (agent.active === false) return false;
    const role = typeof agent.role === 'string' ? agent.role.trim() : '';
    return (role || agent.isDev === true) && agentAcceptsAutonomousTickets(agent);
  });
  return codingAgent?.id ?? null;
}

export function isDeploySetupWizardSession(session: { name?: string | null }): boolean {
  return typeof session.name === 'string' && session.name.startsWith('[Deploy Setup]');
}

export function buildDeploySetupKickoffPrompt(
  projectId: string,
  projectCwd: string,
  sessionId: string,
): string {
  return [
    '# Deploy Setup - guided walkthrough (required)',
    '',
    'You are the default setup path for `.agent-hub/deploy.yaml`, and you run as a normal worktree-backed session. Author the deployment config in this session worktree, validate it, commit it locally, and stop. Finalize Code Changes handles review and push.',
    '',
    '## Bound values',
    '',
    `- PROJECT_ID: \`${projectId}\``,
    `- PROJECT_CWD: \`${projectCwd}\``,
    `- YOUR SESSION_ID: \`${sessionId}\``,
    '- `$AGENT_HUB_URL`, `$AGENT_HUB_API_KEY`: use these for Hub API calls. If any call returns HTTP 401 or 403, halt and report the auth failure. Never ask the operator to paste a token into chat.',
    '',
    '## Required output file',
    '',
    'Write `.agent-hub/deploy.yaml` with schema version 1:',
    '',
    '```yaml',
    'version: 1',
    'environments:',
    '  staging:',
    '    runs-on: ubuntu-24.04',
    '    timeout_minutes: 60',
    '    steps:',
    '      - name: deploy',
    '        run: ./scripts/deploy-staging.sh',
    '  production:',
    '    approval: true',
    '    runs-on: ubuntu-24.04',
    '    timeout_minutes: 60',
    '    steps:',
    '      - name: deploy',
    '        run: ./scripts/deploy-production.sh',
    '```',
    '',
    'Supported keys: top-level `version`, `environments`; environment keys `approval`, `runs-on`, `timeout_minutes`, `steps`; step keys `name`, `run`. Unknown keys fail validation. `version` must be `1`; each environment needs at least one step with a non-empty `run` command.',
    '',
    '## Required walkthrough order',
    '',
    '1. Read `README.md`, `package.json`, `.github/workflows/*`, deploy scripts, Docker files, Terraform or infra folders, and any release docs that exist. Summarize how the app is shipped today.',
    '2. Ask which environments to configure. Offer common choices with fenced `agenthub:ask` JSON: `staging + production`, `dev + staging + production`, or `production only`.',
    '3. For each environment, identify the deploy command and required secrets. If unclear, ask with `agenthub:ask` and include concrete options from the repo scan.',
    '4. Default `approval: true` for production and false for non-production unless the user chooses otherwise.',
    '5. Create or edit `.agent-hub/deploy.yaml` in this session worktree. Do not mutate the project primary checkout.',
    '6. Validate by running a small parser check or the relevant server deploy-config test if this is Agent Hub itself. Then run formatting for touched files if applicable.',
    '7. Commit the setup change locally on this session branch. Do not push or open a PR.',
    '8. Report the configured environments and user-visible behavior change, then close the linked card only after the config is committed.',
    '',
    'Ask JSON must use `question`, `header`, `options[].label`, and `options[].description`; do not use `prompt`, `id`, or `type`.',
    '',
    '<agenthub:skill>',
    JSON.stringify({
      name: 'deploy-setup',
      reason: 'guided deploy.yaml setup',
    }),
    '</agenthub:skill>',
  ].join('\n');
}

function persistDeploySetupKickoffFailure(
  deps: RouteDeps,
  args: {
    sessionId: string;
    agent: Agent;
    engine: string;
    model: string;
    error: unknown;
  },
): void {
  const message =
    args.error instanceof Error ? args.error.message : args.error ? String(args.error) : 'unknown';
  const content = `Deploy setup kickoff failed before instructions could be sent: ${message}`;
  const messageId = uuidv4();
  try {
    deps.stmts.addMessage.run(
      messageId,
      args.sessionId,
      'assistant',
      content,
      args.engine,
      args.model,
      null,
      JSON.stringify({ kind: 'deploy_setup_kickoff_failure' }),
      args.agent.id,
      args.agent.name,
      typeof args.agent.color === 'string' ? args.agent.color : null,
    );
    deps.stmts.touchSession.run(args.sessionId);
    const inserted = deps.stmts.getMessageById.get(messageId);
    if (inserted) {
      deps.broadcast({ type: 'message', sessionId: args.sessionId, message: inserted });
    }
  } catch (err: unknown) {
    const persistMessage = err instanceof Error ? err.message : String(err);
    console.warn(
      `[deploy-wizard] failed to persist kickoff failure for session ${args.sessionId}: ${persistMessage}`,
    );
  }
}

function actionResponse(deployment: DeploymentRow): {
  deployment: Record<string, unknown>;
  steps: DeploymentStepRow[];
  approvals: DeploymentApprovalRow[];
} {
  return {
    deployment: deploymentDto(deployment),
    steps: listDeploymentSteps(deployment.id),
    approvals: listDeploymentApprovals(deployment.id),
  };
}

function deploymentForProject(projectId: string, deploymentId: string): DeploymentRow | null {
  const deployment = getDeployment(deploymentId);
  if (!deployment || deployment.project_id !== projectId) return null;
  return deployment;
}

function configReferencedDeployment(
  projectId: string,
  deploymentId: string | null | undefined,
): DeploymentRow | null {
  if (!deploymentId) return null;
  const deployment = getDeployment(deploymentId);
  if (!deployment || deployment.project_id !== projectId) return null;
  return deployment;
}

function rollbackTargetForEnvironment(
  projectId: string,
  environment: string,
  currentDeploymentId: string | null | undefined,
): DeploymentRow | null {
  return (
    listDeploymentsForEnvironment(projectId, environment, { limit: 50 }).find(
      (deployment) => deployment.status === 'success' && deployment.id !== currentDeploymentId,
    ) ?? null
  );
}

function configEnvironmentDto(
  projectId: string,
  env: DeployEnvironmentConfig,
): Record<string, unknown> {
  const state = getDeploymentEnvironment(projectId, env.name);
  const activeDeployment = configReferencedDeployment(projectId, state?.active_deployment_id);
  const currentDeployment = configReferencedDeployment(projectId, state?.current_deployment_id);
  const [lastDeployment] = listDeploymentsForEnvironment(projectId, env.name, { limit: 1 });
  const rollbackTarget = rollbackTargetForEnvironment(
    projectId,
    env.name,
    state?.current_deployment_id,
  );

  return {
    name: env.name,
    approval: env.approval,
    runsOn: env.runsOn,
    timeoutMinutes: env.timeoutMinutes,
    steps: env.steps,
    currentRef: state?.current_ref ?? null,
    currentDeploymentId: state?.current_deployment_id ?? null,
    activeDeploymentId: state?.active_deployment_id ?? null,
    activeDeployment: nullableDeploymentDto(activeDeployment),
    currentDeployment: nullableDeploymentDto(currentDeployment),
    lastDeployment: nullableDeploymentDto(lastDeployment),
    rollbackTarget: nullableDeploymentDto(rollbackTarget),
  };
}

function deployConfigDto(
  project: Project,
  config: DeployConfig,
): { projectId: string; configPath: string; environments: Record<string, unknown>[] } {
  return {
    projectId: project.id,
    configPath: '.agent-hub/deploy.yaml',
    environments: [...config.environments.values()].map((env) =>
      configEnvironmentDto(project.id, env),
    ),
  };
}

async function cleanupPreparedCheckout(checkout: CheckoutResult | null): Promise<void> {
  if (!checkout) return;
  await rm(checkout.worktreePath, { recursive: true, force: true });
}

function rejectBusyEnvironment(projectId: string, environment: string, res: Response): boolean {
  const activeDeploymentId =
    getDeploymentEnvironment(projectId, environment)?.active_deployment_id ?? null;
  if (!activeDeploymentId) return false;
  res.status(409).json({
    error: `environment is busy: deployment ${activeDeploymentId} is in flight`,
    activeDeploymentId,
  });
  return true;
}

function actorUserId(req: AuthenticatedRequest): string | null {
  return resolveOwnerUserId(req) ?? req.authUser ?? null;
}

function approverUserId(req: AuthenticatedRequest): string {
  return actorUserId(req) ?? 'api-key';
}

function approvalRole(req: AuthenticatedRequest): Role {
  return req.authRole ?? 'User';
}

function mapConfigError(err: DeployConfigError, res: Response): Response {
  const status = err.reason === 'not_found' || err.reason === 'unknown_environment' ? 404 : 400;
  return res.status(status).json({ error: err.message });
}

function mapTriggerError(err: unknown, res: Response): Response {
  if (err instanceof EnvironmentBusyError) {
    return res.status(409).json({
      error: err.message,
      activeDeploymentId: err.activeDeploymentId,
    });
  }
  if (err instanceof DeployConfigError) return mapConfigError(err, res);
  if (err instanceof DeploymentCheckoutError) {
    return res.status(err.reason === 'no_workspace' ? 400 : 400).json({ error: err.message });
  }
  const message = err instanceof Error ? err.message : String(err);
  return res.status(500).json({ error: message });
}

function mapApprovalError(err: unknown, res: Response): Response {
  if (err instanceof DeploymentApprovalError) {
    if (err.reason === 'forbidden') return res.status(403).json({ error: err.message });
    if (err.reason === 'not_found') return res.status(404).json({ error: err.message });
    if (err.reason === 'invalid_status' || err.reason === 'lock_lost') {
      return res.status(409).json({ error: err.message });
    }
    return res.status(400).json({ error: err.message });
  }
  const message = err instanceof Error ? err.message : String(err);
  return res.status(500).json({ error: message });
}

function mapCancelError(err: unknown, res: Response): Response {
  if (err instanceof DeploymentCancelError) {
    if (err.reason === 'not_found') return res.status(404).json({ error: err.message });
    return res.status(409).json({ error: err.message });
  }
  const message = err instanceof Error ? err.message : String(err);
  return res.status(500).json({ error: message });
}

export default function createDeploymentRoutes(
  deps: RouteDeps,
  opts: DeploymentRouteOptions = {},
): Router {
  const router = Router();
  const prepareCheckout = opts.prepareCheckout ?? prepareDeploymentCheckout;
  const loadConfig = opts.loadConfig ?? loadDeployConfig;
  const orchestratorDeps: DeployOrchestratorDeps = {
    broadcast: deps.broadcast,
    orgId: opts.orchestratorDeps?.orgId,
    runnerBackend: opts.orchestratorDeps?.runnerBackend,
    now: opts.orchestratorDeps?.now,
    env: opts.orchestratorDeps?.env,
  };

  router.post(
    '/api/projects/:projectId/deploy/setup-wizard',
    requireRole('Admin'),
    (req: Request, res: Response) => {
      const projectId = req.params.projectId as string;
      const project = deps.findProject(projectId);
      if (!project) return res.status(404).json({ error: 'Project not found' });
      const cwd = project.cwd;
      if (!cwd || typeof cwd !== 'string') {
        return res.status(400).json({ error: 'Project has no cwd configured' });
      }
      const agentId = pickWizardAgent(project);
      if (!agentId) {
        return res
          .status(400)
          .json({ error: 'Project has no active coding/dev agents to host the wizard session' });
      }
      const agentLookup = deps.findAgent(agentId);
      if (!agentLookup)
        return res.status(500).json({ error: 'Wizard agent could not be resolved' });

      const ownerUid = resolveOwnerUserId(req as AuthenticatedRequest);
      const sessionId = uuidv4();
      const engine = agentLookup.agent.engine || 'claude-code';
      const model = resolveEffectiveModel(deps.config, engine, {
        agentModel: agentLookup.agent.model,
        ownerUserId: ownerUid,
      });
      const sessionName = `[Deploy Setup] ${project.name || project.id}`;
      const useWorktree = 1;
      const askMode = 0;
      deps.stmts.createSession.run(
        sessionId,
        agentId,
        sessionName,
        engine,
        model,
        useWorktree,
        askMode,
        1,
      );
      setSessionOwner(sessionId, ownerUid);

      const prompt = buildDeploySetupKickoffPrompt(project.id, cwd, sessionId);
      void deps
        .handleChat(null, {
          type: 'chat',
          agentId,
          sessionId,
          content: prompt,
        })
        .catch((err: unknown) => {
          const message = err instanceof Error ? err.message : String(err);
          console.warn(`[deploy-wizard] handleChat failed for session ${sessionId}: ${message}`);
          persistDeploySetupKickoffFailure(deps, {
            sessionId,
            agent: agentLookup.agent,
            engine,
            model,
            error: err,
          });
        });

      const session = deps.stmts.getSession.get(sessionId) as SessionRow;
      deps.broadcast({
        type: 'deploy_wizard_started',
        projectId: project.id,
        sessionId,
        agentId,
      });
      return res.status(201).json({
        sessionId,
        agentId,
        session,
        configPath: '.agent-hub/deploy.yaml',
      });
    },
  );

  router.get('/api/projects/:projectId/deploy/config', async (req: Request, res: Response) => {
    const projectId = req.params.projectId as string;
    const project = deps.findProject(projectId);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    try {
      const config = await loadConfig(projectDeployYamlPath(project));
      return res.json(deployConfigDto(project, config));
    } catch (err) {
      if (err instanceof DeployConfigError) return mapConfigError(err, res);
      const message = err instanceof Error ? err.message : String(err);
      return res.status(500).json({ error: message });
    }
  });

  router.get('/api/projects/:projectId/deployments', (req: Request, res: Response) => {
    const projectId = req.params.projectId as string;
    if (!deps.findProject(projectId)) return res.status(404).json({ error: 'Project not found' });

    const parsed = DeploymentListQuerySchema.safeParse(req.query);
    if (!parsed.success) return res.status(400).json({ error: 'Invalid query' });

    const { environment, limit, offset } = parsed.data;
    const deployments = environment
      ? listDeploymentsForEnvironment(projectId, environment, { limit, offset })
      : listDeployments(projectId, { limit, offset });
    return res.json({
      deployments: deployments.map(deploymentDto),
      limit: limit ?? 50,
      offset: offset ?? 0,
    });
  });

  router.post('/api/projects/:projectId/deployments', async (req: Request, res: Response) => {
    const projectId = req.params.projectId as string;
    const project = deps.findProject(projectId);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const parsed = TriggerDeploymentRequestSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Invalid request body' });

    if (rejectBusyEnvironment(projectId, parsed.data.environment, res)) return;

    let checkout: CheckoutResult | null = null;
    try {
      checkout = await prepareCheckout({ project, ref: parsed.data.ref });
      const config = await loadConfig(
        path.join(checkout.worktreePath, '.agent-hub', 'deploy.yaml'),
      );
      const deployment = await triggerDeployment(
        {
          projectId,
          environment: parsed.data.environment,
          ref: checkout.resolvedRef,
          worktreePath: checkout.worktreePath,
          config,
          trigger: 'manual',
          triggeredBy: actorUserId(req as AuthenticatedRequest),
          sessionId:
            parsed.data.sessionId ?? (req as AuthenticatedRequest).authSpawnSessionId ?? null,
          meta: parsed.data.meta,
          deferRun: true,
          cleanupWorktreeOnTerminal: true,
        },
        orchestratorDeps,
      );
      return res.status(202).json(actionResponse(deployment));
    } catch (err) {
      await cleanupPreparedCheckout(checkout);
      return mapTriggerError(err, res);
    }
  });

  router.get(
    '/api/projects/:projectId/deployments/:deploymentId',
    (req: Request, res: Response) => {
      const projectId = req.params.projectId as string;
      if (!deps.findProject(projectId)) return res.status(404).json({ error: 'Project not found' });
      const deployment = deploymentForProject(projectId, req.params.deploymentId as string);
      if (!deployment) return res.status(404).json({ error: 'Deployment not found' });
      return res.json({
        deployment: deploymentDto(deployment),
        steps: listDeploymentSteps(deployment.id),
        approvals: listDeploymentApprovals(deployment.id),
        environment: getDeploymentEnvironment(projectId, deployment.environment),
        history: listDeploymentsForEnvironment(projectId, deployment.environment, {
          limit: 25,
        }).map(deploymentDto),
        logs: [],
      });
    },
  );

  router.post(
    '/api/projects/:projectId/deployments/:deploymentId/cancel',
    requireRole('Admin'),
    (req: Request, res: Response) => {
      const projectId = req.params.projectId as string;
      if (!deps.findProject(projectId)) return res.status(404).json({ error: 'Project not found' });
      const deployment = deploymentForProject(projectId, req.params.deploymentId as string);
      if (!deployment) return res.status(404).json({ error: 'Deployment not found' });

      const parsed = CancelDeploymentRequestSchema.safeParse(req.body ?? {});
      if (!parsed.success) return res.status(400).json({ error: 'Invalid request body' });
      try {
        const cancelled = cancelDeployment(
          { deploymentId: deployment.id, reason: parsed.data.reason ?? null },
          orchestratorDeps,
        );
        return res.status(202).json(actionResponse(cancelled));
      } catch (err) {
        return mapCancelError(err, res);
      }
    },
  );

  router.post(
    '/api/projects/:projectId/deployments/:deploymentId/approve',
    requireRole('Admin'),
    async (req: Request, res: Response) => {
      const projectId = req.params.projectId as string;
      if (!deps.findProject(projectId)) return res.status(404).json({ error: 'Project not found' });
      const deployment = deploymentForProject(projectId, req.params.deploymentId as string);
      if (!deployment) return res.status(404).json({ error: 'Deployment not found' });

      const parsed = ApproveDeploymentRequestSchema.safeParse(req.body ?? {});
      if (!parsed.success) return res.status(400).json({ error: 'Invalid request body' });

      try {
        const approved = await approveDeployment(
          {
            deploymentId: deployment.id,
            approverUserId: approverUserId(req as AuthenticatedRequest),
            approverRole: approvalRole(req as AuthenticatedRequest),
            note: parsed.data.note ?? null,
            sessionId: (req as AuthenticatedRequest).authSpawnSessionId ?? null,
            deferRun: true,
          },
          orchestratorDeps,
        );
        return res.status(202).json(actionResponse(approved));
      } catch (err) {
        return mapApprovalError(err, res);
      }
    },
  );

  router.post(
    '/api/projects/:projectId/deployments/:deploymentId/rollback',
    requireRole('Admin'),
    async (req: Request, res: Response) => {
      const projectId = req.params.projectId as string;
      const project = deps.findProject(projectId);
      if (!project) return res.status(404).json({ error: 'Project not found' });
      const source = deploymentForProject(projectId, req.params.deploymentId as string);
      if (!source) return res.status(404).json({ error: 'Deployment not found' });
      if (source.status !== 'success') {
        return res.status(400).json({ error: 'Rollback source must be a successful deployment' });
      }

      const parsed = RollbackDeploymentRequestSchema.safeParse(req.body ?? {});
      if (!parsed.success) return res.status(400).json({ error: 'Invalid request body' });
      if (rejectBusyEnvironment(projectId, source.environment, res)) return;

      let checkout: CheckoutResult | null = null;
      try {
        checkout = await prepareCheckout({ project, ref: source.ref });
        const config = await loadConfig(
          path.join(checkout.worktreePath, '.agent-hub', 'deploy.yaml'),
        );
        const deployment = await triggerDeployment(
          {
            projectId,
            environment: source.environment,
            ref: checkout.resolvedRef,
            worktreePath: checkout.worktreePath,
            config,
            trigger: 'rollback',
            triggeredBy: actorUserId(req as AuthenticatedRequest),
            sourceDeploymentId: source.id,
            sessionId:
              parsed.data.sessionId ?? (req as AuthenticatedRequest).authSpawnSessionId ?? null,
            meta: parsed.data.meta,
            deferRun: true,
            cleanupWorktreeOnTerminal: true,
          },
          orchestratorDeps,
        );
        return res.status(202).json(actionResponse(deployment));
      } catch (err) {
        await cleanupPreparedCheckout(checkout);
        return mapTriggerError(err, res);
      }
    },
  );

  return router;
}
