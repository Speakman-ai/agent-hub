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
  DeploymentEnvironmentReleaseGateRow,
  DeploymentEnvironmentScheduleRow,
  DeploymentEnvironmentTriggerRow,
  DeploymentReleaseItemDetailRow,
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
import { buildDeployOrchestratorDeps } from '../deploy/deploy-trigger-hook.js';
import {
  getDeployment,
  getDeploymentEnvironment,
  DeploymentReleaseItemError,
  listDeploymentReleaseItemsWithContext,
  listDeploymentApprovals,
  listDeployments,
  listDeploymentsForEnvironment,
  listDeploymentSteps,
  releaseEnvironmentLock,
  setDeploymentReleaseItemInclusion,
} from '../deploy/deployment-store.js';
import {
  deleteEnvironmentConfig,
  getEnvironmentConfig,
  resolveEnvironmentConfigs,
  setEnvironmentEnabled,
  type ResolvedEnvironmentConfig,
} from '../deploy/deployment-env-config-store.js';
import {
  createTrigger,
  deleteTrigger,
  DeployTriggerError,
  listTriggersForEnvironment,
  updateTrigger,
} from '../deploy/deployment-trigger-store.js';
import {
  createSchedule,
  deleteSchedule,
  DeployScheduleError,
  listSchedulesForEnvironment,
  updateSchedule,
} from '../deploy/deployment-schedule-store.js';
import {
  refreshScheduleRegistration,
  unregisterSchedule,
} from '../deploy/deploy-schedule-ticker.js';
import {
  createReleaseGate,
  deleteReleaseGate,
  DeployReleaseGateError,
  listReleaseGatesForEnvironment,
  parseGateEpicIds,
  parseGateSessionIds,
  updateReleaseGate,
} from '../deploy/deployment-release-gate-store.js';
import {
  buildReleaseGateResolvers,
  evaluateReleaseGate,
  type ReleaseGateResolvers,
} from '../deploy/release-gate-evaluator.js';
import { requestReleaseGateSweep } from '../deploy/release-gate-ticker.js';
import { getStmts } from '../db.js';
import {
  resolveNotificationRouting,
  upsertNotificationRouting,
} from '../deploy/deployment-notification-routing-store.js';
import { deriveSupportTicketReleaseState, getSupportTicket } from '../support-tickets-store.js';
import { generateDeploymentReleaseDigest, type ReleaseDigestRunner } from '../release-digest.js';
import {
  broadcastReleaseNotificationUpdate,
  listReleaseNotificationOutboxByDeployment,
  listReleaseNotificationRecipientsByDeployment,
  releaseNotificationHistoryItem,
  retryReleaseNotificationOutbox,
} from '../release-notification-outbox.js';
import {
  DeploymentCheckoutError,
  prepareDeploymentCheckout,
} from '../deploy/deployment-checkout.js';
import {
  AdjustDeploymentReleaseItemRequestSchema,
  ApproveDeploymentRequestSchema,
  CancelDeploymentRequestSchema,
  CreateDeployReleaseGateRequestSchema,
  CreateDeployScheduleRequestSchema,
  CreateDeployTriggerRequestSchema,
  DeploymentListQuerySchema,
  EnvironmentConfigUpdateRequestSchema,
  NotificationRoutingUpdateRequestSchema,
  RollbackDeploymentRequestSchema,
  TriggerDeploymentRequestSchema,
  UpdateDeployReleaseGateRequestSchema,
  UpdateDeployScheduleRequestSchema,
  UpdateDeployTriggerRequestSchema,
} from './deployments.openapi.js';

type CheckoutResult = { worktreePath: string; resolvedRef: string };

interface DeploymentRouteOptions {
  prepareCheckout?: (args: { project: Project; ref: string }) => Promise<CheckoutResult>;
  loadConfig?: (deployYamlPath: string) => Promise<DeployConfig>;
  orchestratorDeps?: Partial<DeployOrchestratorDeps>;
  releaseDigestRunner?: ReleaseDigestRunner;
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

function releaseItemDto(row: DeploymentReleaseItemDetailRow): Record<string, unknown> {
  const supportTicket =
    row.support_ticket_id === null
      ? null
      : {
          id: row.support_ticket_id,
          subject: row.support_ticket_subject,
          status: row.support_ticket_status,
          type: row.support_ticket_type,
          releaseState: deriveSupportTicketReleaseState({
            fixed_at: row.support_ticket_fixed_at,
            released_to_prod_at: row.support_ticket_released_to_prod_at,
            customer_notified_at: row.support_ticket_customer_notified_at,
          }),
        };
  return {
    id: row.id,
    deployment_id: row.deployment_id,
    card_id: row.card_id,
    support_ticket_id: row.support_ticket_id,
    source: row.source,
    inclusion_status: row.inclusion_status,
    operator_adjusted_by: row.operator_adjusted_by,
    operator_adjustment_note: row.operator_adjustment_note,
    operator_adjustment_meta: row.operator_adjustment_meta,
    operator_adjusted_at: row.operator_adjusted_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
    card: {
      id: row.card_id,
      title: row.card_title,
      shortId: row.card_short_id,
      priority: row.card_priority,
      columnName: row.card_column_name,
    },
    supportTicket,
  };
}

function releaseItemsDto(deploymentId: string): Record<string, unknown>[] {
  return listDeploymentReleaseItemsWithContext(deploymentId).map(releaseItemDto);
}

function releaseNotificationsDto(deploymentId: string): unknown[] {
  return listReleaseNotificationOutboxByDeployment(deploymentId).map(
    releaseNotificationHistoryItem,
  );
}

function releaseNotificationRecipientsDto(deploymentId: string): unknown[] {
  return listReleaseNotificationRecipientsByDeployment(deploymentId);
}

function deploymentAllowsReleaseItemAdjustments(deployment: DeploymentRow): boolean {
  return deployment.status === 'awaiting_approval';
}

function nullableDeploymentDto(
  row: DeploymentRow | null | undefined,
): Record<string, unknown> | null {
  return row ? deploymentDto(row) : null;
}

const TERMINAL_DEPLOYMENT_STATUSES = new Set(['success', 'error', 'cancelled']);
const TERMINAL_STEP_STATUSES = new Set(['success', 'error', 'skipped', 'cancelled']);

function isTerminalDeploymentStatus(status: unknown): boolean {
  return TERMINAL_DEPLOYMENT_STATUSES.has(String(status || ''));
}

function deploymentActiveInConfig(deployment: DeploymentRow | null): DeploymentRow | null {
  if (!deployment) return null;
  return isTerminalDeploymentStatus(deployment.status) ? null : deployment;
}

function deploymentStepsDto(
  deployment: DeploymentRow,
  steps: DeploymentStepRow[],
): DeploymentStepRow[] {
  if (!isTerminalDeploymentStatus(deployment.status)) return steps;
  let markedError = false;
  return steps.map((step) => {
    if (TERMINAL_STEP_STATUSES.has(String(step.status || ''))) return step;
    if (deployment.status === 'success') return { ...step, status: 'success' };
    if (deployment.status === 'cancelled') {
      return {
        ...step,
        status: 'cancelled',
        error: step.error ?? deployment.error ?? 'Deployment cancelled.',
      };
    }
    if (!markedError) {
      markedError = true;
      return {
        ...step,
        status: 'error',
        error: step.error ?? deployment.error ?? 'Deployment failed.',
      };
    }
    return { ...step, status: 'skipped' };
  });
}

function projectDeployYamlPath(project: Project): string {
  return path.join(project.cwd, '.agent-hub', 'deploy.yaml');
}

function projectUsesHostedGit(project: Project): boolean {
  return project.gitHost === 'agenthub';
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
  const rawActiveDeploymentId = state?.active_deployment_id ?? null;
  const referencedActiveDeployment = configReferencedDeployment(projectId, rawActiveDeploymentId);
  const activeDeployment = deploymentActiveInConfig(referencedActiveDeployment);
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
    activeDeploymentId:
      activeDeployment?.id ?? (referencedActiveDeployment ? null : rawActiveDeploymentId),
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

function runtimeConfigDto(
  row: ResolvedEnvironmentConfig['config'],
): Record<string, unknown> | null {
  if (!row) return null;
  return {
    id: row.id,
    enabled: row.enabled === 1,
    meta: parseMeta(row.meta),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Merge one resolved environment (deploy.yaml declaration + operator runtime
 * config) into the read-API DTO. Declared pipeline metadata (approval, steps, …)
 * is present only for `active` environments; an orphaned config row (env removed
 * from deploy.yaml) reports `active:false`, `deployable:false`, and null pipeline
 * fields while still carrying its stored `config` so the management UI can
 * surface and re-enable or remove it. Rollback is out of scope, so no rollback
 * target is exposed here.
 */
function resolvedEnvironmentDto(
  projectId: string,
  resolved: ResolvedEnvironmentConfig,
  declared: DeployEnvironmentConfig | undefined,
): Record<string, unknown> {
  const state = getDeploymentEnvironment(projectId, resolved.environmentName);
  const [lastDeployment] = listDeploymentsForEnvironment(projectId, resolved.environmentName, {
    limit: 1,
  });
  return {
    name: resolved.environmentName,
    active: resolved.active,
    enabled: resolved.enabled,
    deployable: resolved.deployable,
    approval: declared?.approval ?? null,
    runsOn: declared?.runsOn ?? null,
    timeoutMinutes: declared?.timeoutMinutes ?? null,
    steps: declared?.steps ?? [],
    currentRef: state?.current_ref ?? null,
    currentDeploymentId: state?.current_deployment_id ?? null,
    lastDeployment: nullableDeploymentDto(lastDeployment),
    config: runtimeConfigDto(resolved.config),
  };
}

/**
 * The resolved multi-environment view: every deploy.yaml-declared environment
 * plus every orphaned operator config row, each tagged active/enabled/deployable.
 * Unlike {@link deployConfigDto} (which only iterates the deploy.yaml map), this
 * surfaces config rows whose environment was removed from deploy.yaml so they are
 * never silently dropped — the `environments-config` epic decision.
 */
function environmentsReadDto(
  project: Project,
  config: DeployConfig,
): { projectId: string; configPath: string; environments: Record<string, unknown>[] } {
  const declaredByName = new Map([...config.environments.values()].map((env) => [env.name, env]));
  const resolved = resolveEnvironmentConfigs(project.id, declaredByName.keys());
  return {
    projectId: project.id,
    configPath: '.agent-hub/deploy.yaml',
    environments: resolved.map((entry) =>
      resolvedEnvironmentDto(project.id, entry, declaredByName.get(entry.environmentName)),
    ),
  };
}

async function cleanupPreparedCheckout(checkout: CheckoutResult | null): Promise<void> {
  if (!checkout) return;
  await rm(checkout.worktreePath, { recursive: true, force: true });
}

/**
 * Load the project's deploy.yaml (via a hosted-git checkout when required) and
 * run a synchronous callback against it, always cleaning up the checkout. A
 * missing deploy.yaml is NOT an error here: it resolves to an empty declared set
 * so operator config rows (including orphaned ones) are still surfaced and
 * editable. A malformed deploy.yaml still throws. `fn` must be synchronous — the
 * env runtime config store uses synchronous better-sqlite3 calls, so reads,
 * writes, and DTO assembly happen against the same in-memory config snapshot
 * without a second checkout.
 */
async function withDeployConfig<T>(
  project: Project,
  prepareCheckout: (args: { project: Project; ref: string }) => Promise<CheckoutResult>,
  loadConfig: (deployYamlPath: string) => Promise<DeployConfig>,
  fn: (config: DeployConfig) => T,
): Promise<T> {
  let checkout: CheckoutResult | null = null;
  try {
    let config: DeployConfig;
    try {
      if (projectUsesHostedGit(project)) {
        checkout = await prepareCheckout({ project, ref: 'HEAD' });
      }
      config = await loadConfig(
        checkout
          ? path.join(checkout.worktreePath, '.agent-hub', 'deploy.yaml')
          : projectDeployYamlPath(project),
      );
    } catch (err) {
      if (err instanceof DeployConfigError && err.reason === 'not_found') {
        config = { version: 1, environments: new Map() };
      } else {
        throw err;
      }
    }
    return fn(config);
  } finally {
    await cleanupPreparedCheckout(checkout);
  }
}

/** Names declared in the current deploy.yaml (trimmed, deduped). */
function declaredEnvironmentNames(config: DeployConfig): Set<string> {
  return new Set([...config.environments.values()].map((env) => env.name.trim()));
}

function rejectBusyEnvironment(projectId: string, environment: string, res: Response): boolean {
  const activeDeploymentId =
    getDeploymentEnvironment(projectId, environment)?.active_deployment_id ?? null;
  if (!activeDeploymentId) return false;
  const activeDeployment = configReferencedDeployment(projectId, activeDeploymentId);
  if (activeDeployment && isTerminalDeploymentStatus(activeDeployment.status)) {
    releaseEnvironmentLock(projectId, environment, activeDeployment.id);
    return false;
  }
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

function triggerDto(row: DeploymentEnvironmentTriggerRow): Record<string, unknown> {
  return {
    id: row.id,
    projectId: row.project_id,
    environmentName: row.environment_name,
    event: row.event,
    branchPattern: row.branch_pattern,
    enabled: row.enabled === 1,
    meta: parseMeta(row.meta),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapTriggerStoreError(err: unknown, res: Response): Response {
  if (err instanceof DeployTriggerError) {
    if (err.reason === 'duplicate') return res.status(409).json({ error: err.message });
    if (err.reason === 'not_found') return res.status(404).json({ error: err.message });
    return res.status(400).json({ error: err.message });
  }
  const message = err instanceof Error ? err.message : String(err);
  return res.status(500).json({ error: message });
}

function scheduleDto(row: DeploymentEnvironmentScheduleRow): Record<string, unknown> {
  return {
    id: row.id,
    projectId: row.project_id,
    environmentName: row.environment_name,
    ref: row.ref,
    cron: row.cron,
    timezone: row.timezone,
    ownerUserId: row.owner_user_id,
    enabled: row.enabled === 1,
    meta: parseMeta(row.meta),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapScheduleStoreError(err: unknown, res: Response): Response {
  if (err instanceof DeployScheduleError) {
    if (err.reason === 'duplicate') return res.status(409).json({ error: err.message });
    if (err.reason === 'not_found') return res.status(404).json({ error: err.message });
    return res.status(400).json({ error: err.message });
  }
  const message = err instanceof Error ? err.message : String(err);
  return res.status(500).json({ error: message });
}

function releaseGateDto(
  row: DeploymentEnvironmentReleaseGateRow,
  resolvers: ReleaseGateResolvers,
): Record<string, unknown> {
  // Only armed gates carry a live "satisfied" meaning; a fired/failed gate's
  // progress is a historical snapshot, so surface `satisfied: false` for those.
  const evaluation = evaluateReleaseGate(row, resolvers);
  return {
    id: row.id,
    projectId: row.project_id,
    environmentName: row.environment_name,
    ref: row.ref,
    sessionIds: parseGateSessionIds(row),
    epicIds: parseGateEpicIds(row),
    ownerUserId: row.owner_user_id,
    status: row.status,
    enabled: row.enabled === 1,
    firedDeploymentId: row.fired_deployment_id,
    lastError: row.last_error,
    resolvedAt: row.resolved_at,
    progress: {
      sessions: evaluation.sessions,
      epics: evaluation.epics,
      sessionsComplete: evaluation.sessionsComplete,
      sessionsTotal: evaluation.sessionsTotal,
      epicsComplete: evaluation.epicsComplete,
      epicsTotal: evaluation.epicsTotal,
      blocked: evaluation.blocked,
      satisfied: row.status === 'armed' && row.enabled === 1 && evaluation.satisfied,
    },
    meta: parseMeta(row.meta),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapReleaseGateStoreError(err: unknown, res: Response): Response {
  if (err instanceof DeployReleaseGateError) {
    if (err.reason === 'not_found') return res.status(404).json({ error: err.message });
    return res.status(400).json({ error: err.message });
  }
  const message = err instanceof Error ? err.message : String(err);
  return res.status(500).json({ error: message });
}

function notificationRoutingDto(
  routing: ReturnType<typeof resolveNotificationRouting>,
): Record<string, unknown> {
  return {
    environmentName: routing.environmentName,
    isProduction: routing.isProduction,
    ticketReleaseEnabled: routing.ticketReleaseEnabled,
    releaseDigestEnabled: routing.releaseDigestEnabled,
    isDefault: routing.isDefault,
    updatedAt: routing.config?.updated_at ?? null,
  };
}

function mapReleaseItemError(err: unknown, res: Response): Response {
  if (err instanceof DeploymentReleaseItemError) {
    if (err.reason === 'not_found' || err.reason === 'cross_project') {
      return res.status(404).json({ error: err.message });
    }
    return res.status(400).json({ error: err.message });
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
  // Shared with the push/merge trigger hook so the manual-deploy and
  // trigger-driven paths never drift on GitHub-token / repo / recovery-checkout
  // / release-digest wiring.
  const orchestratorDeps: DeployOrchestratorDeps = buildDeployOrchestratorDeps({
    broadcast: deps.broadcast,
    config: deps.config,
    findProject: deps.findProject,
    prepareCheckout,
    releaseDigestRunner: opts.releaseDigestRunner,
    overrides: opts.orchestratorDeps,
  });

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
        agentId,
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

    let checkout: CheckoutResult | null = null;
    try {
      if (projectUsesHostedGit(project)) {
        checkout = await prepareCheckout({ project, ref: 'HEAD' });
      }
      const config = await loadConfig(
        checkout
          ? path.join(checkout.worktreePath, '.agent-hub', 'deploy.yaml')
          : projectDeployYamlPath(project),
      );
      return res.json(deployConfigDto(project, config));
    } catch (err) {
      if (err instanceof DeployConfigError) return mapConfigError(err, res);
      if (err instanceof DeploymentCheckoutError) return mapTriggerError(err, res);
      const message = err instanceof Error ? err.message : String(err);
      return res.status(500).json({ error: message });
    } finally {
      await cleanupPreparedCheckout(checkout);
    }
  });

  router.get(
    '/api/projects/:projectId/deploy/environments',
    async (req: Request, res: Response) => {
      const projectId = req.params.projectId as string;
      const project = deps.findProject(projectId);
      if (!project) return res.status(404).json({ error: 'Project not found' });

      try {
        const dto = await withDeployConfig(project, prepareCheckout, loadConfig, (config) =>
          environmentsReadDto(project, config),
        );
        return res.json(dto);
      } catch (err) {
        if (err instanceof DeployConfigError) return mapConfigError(err, res);
        if (err instanceof DeploymentCheckoutError) return mapTriggerError(err, res);
        const message = err instanceof Error ? err.message : String(err);
        return res.status(500).json({ error: message });
      }
    },
  );

  // Operator enable/disable for one environment's runtime config. deploy.yaml
  // stays the source of truth for WHICH environments exist (environments-config
  // epic decision); this only flips the no-commit-needed pause switch. Allowed on
  // any environment that is either declared in deploy.yaml OR already has a config
  // row (so an orphaned env can be re-enabled/paused before its config is removed);
  // an unknown name is 404 so a typo never strands a junk config row.
  router.patch(
    '/api/projects/:projectId/deploy/environments/:environmentName',
    requireRole('Admin'),
    async (req: Request, res: Response) => {
      const projectId = req.params.projectId as string;
      const environmentName = String(req.params.environmentName ?? '').trim();
      const project = deps.findProject(projectId);
      if (!project) return res.status(404).json({ error: 'Project not found' });

      const parsed = EnvironmentConfigUpdateRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid body' });
      }

      try {
        const dto = await withDeployConfig(project, prepareCheckout, loadConfig, (config) => {
          const declared = declaredEnvironmentNames(config);
          const hasConfigRow = getEnvironmentConfig(projectId, environmentName) != null;
          if (!declared.has(environmentName) && !hasConfigRow) {
            throw new DeployConfigError(
              'unknown_environment',
              `Unknown environment: ${environmentName}`,
            );
          }
          setEnvironmentEnabled(projectId, environmentName, parsed.data.enabled);
          return environmentsReadDto(project, config);
        });
        return res.json(dto);
      } catch (err) {
        if (err instanceof DeployConfigError) return mapConfigError(err, res);
        if (err instanceof DeploymentCheckoutError) return mapTriggerError(err, res);
        const message = err instanceof Error ? err.message : String(err);
        return res.status(500).json({ error: message });
      }
    },
  );

  // Remove one environment's runtime config row. For a still-declared env this
  // resets it to the default (enabled, no meta); for an orphaned env (removed from
  // deploy.yaml) this is the cleanup path so stale rows do not linger forever.
  router.delete(
    '/api/projects/:projectId/deploy/environments/:environmentName',
    requireRole('Admin'),
    async (req: Request, res: Response) => {
      const projectId = req.params.projectId as string;
      const environmentName = String(req.params.environmentName ?? '').trim();
      const project = deps.findProject(projectId);
      if (!project) return res.status(404).json({ error: 'Project not found' });

      try {
        const { removed, dto } = await withDeployConfig(
          project,
          prepareCheckout,
          loadConfig,
          (config) => {
            const wasRemoved = deleteEnvironmentConfig(projectId, environmentName);
            return { removed: wasRemoved, dto: environmentsReadDto(project, config) };
          },
        );
        return res.json({ removed, ...dto });
      } catch (err) {
        if (err instanceof DeployConfigError) return mapConfigError(err, res);
        if (err instanceof DeploymentCheckoutError) return mapTriggerError(err, res);
        const message = err instanceof Error ? err.message : String(err);
        return res.status(500).json({ error: message });
      }
    },
  );

  // ----- Per-environment deploy triggers (deploy-triggers epic decision) -----
  // Operator-editable git-event triggers keyed by (project, environment): a
  // matching push/merge enqueues a deployment for the mapped environment. The
  // hook evaluation / enqueue path is a sibling card; this is the store + CRUD.

  router.get(
    '/api/projects/:projectId/deploy/environments/:environmentName/triggers',
    (req: Request, res: Response) => {
      const projectId = req.params.projectId as string;
      const environmentName = String(req.params.environmentName ?? '').trim();
      if (!deps.findProject(projectId)) return res.status(404).json({ error: 'Project not found' });
      const triggers = listTriggersForEnvironment(projectId, environmentName).map(triggerDto);
      return res.json({ projectId, environmentName, triggers });
    },
  );

  router.post(
    '/api/projects/:projectId/deploy/environments/:environmentName/triggers',
    requireRole('Admin'),
    async (req: Request, res: Response) => {
      const projectId = req.params.projectId as string;
      const environmentName = String(req.params.environmentName ?? '').trim();
      const project = deps.findProject(projectId);
      if (!project) return res.status(404).json({ error: 'Project not found' });

      const parsed = CreateDeployTriggerRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid body' });
      }

      try {
        // Guard against typos the same way the environment PATCH does: the env
        // must be declared in deploy.yaml OR already have a runtime config row,
        // so a trigger never strands against a non-existent environment name.
        const trigger = await withDeployConfig(project, prepareCheckout, loadConfig, (config) => {
          const declared = declaredEnvironmentNames(config);
          const hasConfigRow = getEnvironmentConfig(projectId, environmentName) != null;
          if (!declared.has(environmentName) && !hasConfigRow) {
            throw new DeployConfigError(
              'unknown_environment',
              `Unknown environment: ${environmentName}`,
            );
          }
          return createTrigger({
            projectId,
            environmentName,
            event: parsed.data.event,
            branchPattern: parsed.data.branchPattern,
            enabled: parsed.data.enabled,
            meta: parsed.data.meta,
          });
        });
        return res.status(201).json({ trigger: triggerDto(trigger) });
      } catch (err) {
        if (err instanceof DeployConfigError) return mapConfigError(err, res);
        if (err instanceof DeploymentCheckoutError) return mapTriggerError(err, res);
        return mapTriggerStoreError(err, res);
      }
    },
  );

  router.patch(
    '/api/projects/:projectId/deploy/environments/:environmentName/triggers/:triggerId',
    requireRole('Admin'),
    (req: Request, res: Response) => {
      const projectId = req.params.projectId as string;
      const triggerId = req.params.triggerId as string;
      if (!deps.findProject(projectId)) return res.status(404).json({ error: 'Project not found' });

      const parsed = UpdateDeployTriggerRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid body' });
      }

      try {
        const updated = updateTrigger(projectId, triggerId, parsed.data);
        if (!updated) return res.status(404).json({ error: 'Deploy trigger not found' });
        return res.json({ trigger: triggerDto(updated) });
      } catch (err) {
        return mapTriggerStoreError(err, res);
      }
    },
  );

  router.delete(
    '/api/projects/:projectId/deploy/environments/:environmentName/triggers/:triggerId',
    requireRole('Admin'),
    (req: Request, res: Response) => {
      const projectId = req.params.projectId as string;
      const triggerId = req.params.triggerId as string;
      if (!deps.findProject(projectId)) return res.status(404).json({ error: 'Project not found' });
      if (!deleteTrigger(projectId, triggerId)) {
        return res.status(404).json({ error: 'Deploy trigger not found' });
      }
      return res.json({ removed: true });
    },
  );

  router.get(
    '/api/projects/:projectId/deploy/environments/:environmentName/schedules',
    (req: Request, res: Response) => {
      const projectId = req.params.projectId as string;
      const environmentName = String(req.params.environmentName ?? '').trim();
      if (!deps.findProject(projectId)) return res.status(404).json({ error: 'Project not found' });
      const schedules = listSchedulesForEnvironment(projectId, environmentName).map(scheduleDto);
      return res.json({ projectId, environmentName, schedules });
    },
  );

  router.post(
    '/api/projects/:projectId/deploy/environments/:environmentName/schedules',
    requireRole('Admin'),
    async (req: Request, res: Response) => {
      const projectId = req.params.projectId as string;
      const environmentName = String(req.params.environmentName ?? '').trim();
      const project = deps.findProject(projectId);
      if (!project) return res.status(404).json({ error: 'Project not found' });

      const parsed = CreateDeployScheduleRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid body' });
      }

      try {
        // Guard against typos the same way the trigger POST does: the env must be
        // declared in deploy.yaml OR already have a runtime config row, so a
        // schedule never strands against a non-existent environment name.
        const schedule = await withDeployConfig(project, prepareCheckout, loadConfig, (config) => {
          const declared = declaredEnvironmentNames(config);
          const hasConfigRow = getEnvironmentConfig(projectId, environmentName) != null;
          if (!declared.has(environmentName) && !hasConfigRow) {
            throw new DeployConfigError(
              'unknown_environment',
              `Unknown environment: ${environmentName}`,
            );
          }
          return createSchedule({
            projectId,
            environmentName,
            ref: parsed.data.ref,
            cron: parsed.data.cron,
            timezone: parsed.data.timezone,
            // The scheduled run spawns under the creator's identity (deploy-scheduling).
            ownerUserId: actorUserId(req as AuthenticatedRequest),
            enabled: parsed.data.enabled,
            meta: parsed.data.meta,
          });
        });
        // Arm the node-cron task immediately so a new schedule fires without a
        // server restart (no-op until the boot ticker has been initialized).
        refreshScheduleRegistration(projectId, schedule.id);
        return res.status(201).json({ schedule: scheduleDto(schedule) });
      } catch (err) {
        if (err instanceof DeployConfigError) return mapConfigError(err, res);
        if (err instanceof DeploymentCheckoutError) return mapTriggerError(err, res);
        return mapScheduleStoreError(err, res);
      }
    },
  );

  router.patch(
    '/api/projects/:projectId/deploy/environments/:environmentName/schedules/:scheduleId',
    requireRole('Admin'),
    (req: Request, res: Response) => {
      const projectId = req.params.projectId as string;
      const scheduleId = req.params.scheduleId as string;
      if (!deps.findProject(projectId)) return res.status(404).json({ error: 'Project not found' });

      const parsed = UpdateDeployScheduleRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid body' });
      }

      try {
        const updated = updateSchedule(projectId, scheduleId, parsed.data);
        if (!updated) return res.status(404).json({ error: 'Deploy schedule not found' });
        // Re-sync the node-cron task: an edited cron/timezone re-arms, a flip to
        // disabled stops it (retained pause), a flip back on re-registers it.
        refreshScheduleRegistration(projectId, scheduleId);
        return res.json({ schedule: scheduleDto(updated) });
      } catch (err) {
        return mapScheduleStoreError(err, res);
      }
    },
  );

  router.delete(
    '/api/projects/:projectId/deploy/environments/:environmentName/schedules/:scheduleId',
    requireRole('Admin'),
    (req: Request, res: Response) => {
      const projectId = req.params.projectId as string;
      const scheduleId = req.params.scheduleId as string;
      if (!deps.findProject(projectId)) return res.status(404).json({ error: 'Project not found' });
      if (!deleteSchedule(projectId, scheduleId)) {
        return res.status(404).json({ error: 'Deploy schedule not found' });
      }
      // Stop the running node-cron task so a deleted schedule stops firing.
      unregisterSchedule(scheduleId);
      return res.json({ removed: true });
    },
  );

  // ----- Per-environment release gates (release-gate decision) ---------------
  // Operator-editable one-shot gates that fire a single deployment once their
  // selected sessions are all merged AND their selected epics are all done. The
  // list read evaluates live completion progress against the current DB state.

  router.get(
    '/api/projects/:projectId/deploy/environments/:environmentName/release-gates',
    (req: Request, res: Response) => {
      const projectId = req.params.projectId as string;
      const environmentName = String(req.params.environmentName ?? '').trim();
      if (!deps.findProject(projectId)) return res.status(404).json({ error: 'Project not found' });
      const resolvers = buildReleaseGateResolvers(getStmts());
      const gates = listReleaseGatesForEnvironment(projectId, environmentName).map((row) =>
        releaseGateDto(row, resolvers),
      );
      return res.json({ projectId, environmentName, gates });
    },
  );

  router.post(
    '/api/projects/:projectId/deploy/environments/:environmentName/release-gates',
    requireRole('Admin'),
    async (req: Request, res: Response) => {
      const projectId = req.params.projectId as string;
      const environmentName = String(req.params.environmentName ?? '').trim();
      const project = deps.findProject(projectId);
      if (!project) return res.status(404).json({ error: 'Project not found' });

      const parsed = CreateDeployReleaseGateRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid body' });
      }

      try {
        // Guard against typos the same way the trigger/schedule POSTs do: the env
        // must be declared in deploy.yaml OR already have a runtime config row.
        const gate = await withDeployConfig(project, prepareCheckout, loadConfig, (config) => {
          const declared = declaredEnvironmentNames(config);
          const hasConfigRow = getEnvironmentConfig(projectId, environmentName) != null;
          if (!declared.has(environmentName) && !hasConfigRow) {
            throw new DeployConfigError(
              'unknown_environment',
              `Unknown environment: ${environmentName}`,
            );
          }
          return createReleaseGate({
            projectId,
            environmentName,
            ref: parsed.data.ref,
            sessionIds: parsed.data.sessionIds,
            epicIds: parsed.data.epicIds,
            // The fired deployment spawns under the creator's identity.
            ownerUserId: actorUserId(req as AuthenticatedRequest),
            enabled: parsed.data.enabled,
            meta: parsed.data.meta,
          });
        });
        // A newly-created gate may already be satisfied (all selections already
        // complete) — nudge an off-cadence sweep so it fires without waiting.
        requestReleaseGateSweep('gate-created');
        const resolvers = buildReleaseGateResolvers(getStmts());
        return res.status(201).json({ gate: releaseGateDto(gate, resolvers) });
      } catch (err) {
        if (err instanceof DeployConfigError) return mapConfigError(err, res);
        if (err instanceof DeploymentCheckoutError) return mapTriggerError(err, res);
        return mapReleaseGateStoreError(err, res);
      }
    },
  );

  router.patch(
    '/api/projects/:projectId/deploy/environments/:environmentName/release-gates/:gateId',
    requireRole('Admin'),
    (req: Request, res: Response) => {
      const projectId = req.params.projectId as string;
      const gateId = req.params.gateId as string;
      if (!deps.findProject(projectId)) return res.status(404).json({ error: 'Project not found' });

      const parsed = UpdateDeployReleaseGateRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid body' });
      }

      try {
        const updated = updateReleaseGate(projectId, gateId, parsed.data);
        if (!updated) return res.status(404).json({ error: 'Release gate not found' });
        // Re-enabling or re-scoping a gate may make it fire — nudge a sweep.
        requestReleaseGateSweep('gate-updated');
        const resolvers = buildReleaseGateResolvers(getStmts());
        return res.json({ gate: releaseGateDto(updated, resolvers) });
      } catch (err) {
        return mapReleaseGateStoreError(err, res);
      }
    },
  );

  router.delete(
    '/api/projects/:projectId/deploy/environments/:environmentName/release-gates/:gateId',
    requireRole('Admin'),
    (req: Request, res: Response) => {
      const projectId = req.params.projectId as string;
      const gateId = req.params.gateId as string;
      if (!deps.findProject(projectId)) return res.status(404).json({ error: 'Project not found' });
      if (!deleteReleaseGate(projectId, gateId)) {
        return res.status(404).json({ error: 'Release gate not found' });
      }
      return res.json({ removed: true });
    },
  );

  // ----- Per-environment notification routing (notification-routing decision) -
  // Operator-editable selection of which release notification types fire when a
  // deployment to this environment succeeds. The resolved read reflects the
  // env-name default (prod → reporter + digest, non-prod → nothing) until an
  // operator saves an explicit override.

  router.get(
    '/api/projects/:projectId/deploy/environments/:environmentName/notification-routing',
    (req: Request, res: Response) => {
      const projectId = req.params.projectId as string;
      const environmentName = String(req.params.environmentName ?? '').trim();
      if (!deps.findProject(projectId)) return res.status(404).json({ error: 'Project not found' });
      const routing = resolveNotificationRouting(projectId, environmentName);
      return res.json({ projectId, routing: notificationRoutingDto(routing) });
    },
  );

  router.put(
    '/api/projects/:projectId/deploy/environments/:environmentName/notification-routing',
    requireRole('Admin'),
    async (req: Request, res: Response) => {
      const projectId = req.params.projectId as string;
      const environmentName = String(req.params.environmentName ?? '').trim();
      const project = deps.findProject(projectId);
      if (!project) return res.status(404).json({ error: 'Project not found' });

      const parsed = NotificationRoutingUpdateRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid body' });
      }

      try {
        // Guard against typos the same way the trigger/schedule POSTs do: the env
        // must be declared in deploy.yaml OR already have a runtime config row, so
        // routing never strands against a non-existent environment name.
        await withDeployConfig(project, prepareCheckout, loadConfig, (config) => {
          const declared = declaredEnvironmentNames(config);
          const hasConfigRow = getEnvironmentConfig(projectId, environmentName) != null;
          if (!declared.has(environmentName) && !hasConfigRow) {
            throw new DeployConfigError(
              'unknown_environment',
              `Unknown environment: ${environmentName}`,
            );
          }
          return upsertNotificationRouting({
            projectId,
            environmentName,
            ticketReleaseEnabled: parsed.data.ticketReleaseEnabled,
            releaseDigestEnabled: parsed.data.releaseDigestEnabled,
            meta: parsed.data.meta,
          });
        });
        const routing = resolveNotificationRouting(projectId, environmentName);
        return res.json({ projectId, routing: notificationRoutingDto(routing) });
      } catch (err) {
        if (err instanceof DeployConfigError) return mapConfigError(err, res);
        if (err instanceof DeploymentCheckoutError) return mapTriggerError(err, res);
        const message = err instanceof Error ? err.message : String(err);
        return res.status(500).json({ error: message });
      }
    },
  );

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
        steps: deploymentStepsDto(deployment, listDeploymentSteps(deployment.id)),
        approvals: listDeploymentApprovals(deployment.id),
        releaseItems: releaseItemsDto(deployment.id),
        releaseNotifications: releaseNotificationsDto(deployment.id),
        environment: getDeploymentEnvironment(projectId, deployment.environment),
        history: listDeploymentsForEnvironment(projectId, deployment.environment, {
          limit: 25,
        }).map(deploymentDto),
        logs: [],
      });
    },
  );

  router.get(
    '/api/projects/:projectId/deployments/:deploymentId/release-items',
    (req: Request, res: Response) => {
      const projectId = req.params.projectId as string;
      if (!deps.findProject(projectId)) return res.status(404).json({ error: 'Project not found' });
      const deployment = deploymentForProject(projectId, req.params.deploymentId as string);
      if (!deployment) return res.status(404).json({ error: 'Deployment not found' });
      return res.json({ releaseItems: releaseItemsDto(deployment.id) });
    },
  );

  router.get(
    '/api/projects/:projectId/deployments/:deploymentId/notification-recipients',
    requireRole('Admin'),
    (req: Request, res: Response) => {
      const projectId = req.params.projectId as string;
      if (!deps.findProject(projectId)) return res.status(404).json({ error: 'Project not found' });
      const deployment = deploymentForProject(projectId, req.params.deploymentId as string);
      if (!deployment) return res.status(404).json({ error: 'Deployment not found' });
      return res.json({ recipients: releaseNotificationRecipientsDto(deployment.id) });
    },
  );

  router.post(
    '/api/projects/:projectId/deployments/:deploymentId/release-notifications/:notificationId/retry',
    requireRole('Admin'),
    (req: Request, res: Response) => {
      const projectId = req.params.projectId as string;
      if (!deps.findProject(projectId)) return res.status(404).json({ error: 'Project not found' });
      const deployment = deploymentForProject(projectId, req.params.deploymentId as string);
      if (!deployment) return res.status(404).json({ error: 'Deployment not found' });
      const row = listReleaseNotificationOutboxByDeployment(deployment.id).find(
        (candidate) => candidate.id === req.params.notificationId,
      );
      if (!row) return res.status(404).json({ error: 'Release notification not found' });
      if (row.sent_at) {
        return res.status(409).json({ error: 'Release notification has already been sent' });
      }
      if (row.status !== 'error') {
        return res.status(409).json({ error: 'Only failed release notifications can be retried' });
      }
      const retried = retryReleaseNotificationOutbox(row.id);
      if (!retried) {
        return res.status(409).json({ error: 'Release notification is no longer retryable' });
      }
      // Re-queuing flips the row back to pending; fan out so other viewers
      // see the state change without refetching. Best-effort by contract.
      broadcastReleaseNotificationUpdate(deps.broadcast, projectId, deployment.id);
      return res.json({
        notification: releaseNotificationHistoryItem(retried),
        releaseNotifications: releaseNotificationsDto(deployment.id),
      });
    },
  );

  router.post(
    '/api/projects/:projectId/deployments/:deploymentId/release-digest',
    requireRole('Admin'),
    async (req: Request, res: Response) => {
      const projectId = req.params.projectId as string;
      const project = deps.findProject(projectId);
      if (!project) return res.status(404).json({ error: 'Project not found' });
      const deployment = deploymentForProject(projectId, req.params.deploymentId as string);
      if (!deployment) return res.status(404).json({ error: 'Deployment not found' });

      try {
        const result = await generateDeploymentReleaseDigest({
          projectId,
          deploymentId: deployment.id,
          cfg: deps.config,
          userId: (req as AuthenticatedRequest).authUserId ?? null,
          runner: opts.releaseDigestRunner,
        });
        return res.json({
          digestMarkdown: result.digestMarkdown,
          settings: result.settings,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return res.status(message === 'Deployment not found' ? 404 : 500).json({ error: message });
      }
    },
  );

  router.put(
    '/api/projects/:projectId/deployments/:deploymentId/release-items/:cardId',
    requireRole('Admin'),
    (req: Request, res: Response) => {
      const projectId = req.params.projectId as string;
      if (!deps.findProject(projectId)) return res.status(404).json({ error: 'Project not found' });
      const deployment = deploymentForProject(projectId, req.params.deploymentId as string);
      if (!deployment) return res.status(404).json({ error: 'Deployment not found' });
      if (!deploymentAllowsReleaseItemAdjustments(deployment)) {
        return res.status(409).json({
          error: 'Release items can only be adjusted while deployment approval is pending',
        });
      }

      const parsed = AdjustDeploymentReleaseItemRequestSchema.safeParse(req.body ?? {});
      if (!parsed.success) return res.status(400).json({ error: 'Invalid request body' });
      const requestedSupportTicketId = parsed.data.supportTicketId;
      if (requestedSupportTicketId) {
        const ticket = getSupportTicket(requestedSupportTicketId);
        if (!ticket || ticket.project_id !== projectId) {
          return res.status(400).json({
            error: `support ticket ${requestedSupportTicketId} does not belong to the deployment project`,
          });
        }
      }

      try {
        const item = setDeploymentReleaseItemInclusion({
          deploymentId: deployment.id,
          cardId: req.params.cardId as string,
          inclusionStatus: parsed.data.inclusionStatus,
          adjustedBy: actorUserId(req as AuthenticatedRequest),
          note: parsed.data.reason,
          supportTicketId:
            parsed.data.supportTicketId === undefined ? undefined : parsed.data.supportTicketId,
          meta: { source: 'release-review-api' },
        });
        const releaseItems = releaseItemsDto(deployment.id);
        const releaseItem = releaseItems.find((candidate) => candidate.id === item.id);
        if (!releaseItem) {
          return res.status(500).json({ error: 'Adjusted release item could not be reloaded' });
        }
        return res.json({
          releaseItem,
          releaseItems,
        });
      } catch (err) {
        return mapReleaseItemError(err, res);
      }
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
