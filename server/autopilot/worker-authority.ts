/**
 * Scoped Autopilot worker credentials.
 *
 * Unattended workers must not inherit the Hub break-glass API key or the
 * credential owner's unrestricted project access. Keys are named
 * `autopilot:<projectId>:<runId>` and enforced at the API layer.
 */

import type { Request, Response, NextFunction } from 'express';
import { createApiKey, revokeApiKeysByName } from '../api-keys-store.js';
import type { AutopilotWorkerRole, AutopilotWorkerScope } from './types.js';

export const AUTOPILOT_WORKER_KEY_PREFIX = 'autopilot:';

export const AUTOPILOT_WORKER_PROTECTED_CONFIG_FIELDS = [
  'brief',
  'evaluatorPolicy',
  'limits',
  'target',
  'credentialOwnerUserId',
  'enabled',
] as const;

const CLOUD_AND_SOCKET_ENV_KEYS = [
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'AWS_SECURITY_TOKEN',
  'AWS_PROFILE',
  'AWS_SHARED_CREDENTIALS_FILE',
  'AWS_CONFIG_FILE',
  'AWS_DEFAULT_PROFILE',
  'GOOGLE_APPLICATION_CREDENTIALS',
  'CLOUDSDK_AUTH_ACCESS_TOKEN',
  'AZURE_CLIENT_SECRET',
  'AZURE_CLIENT_ID',
  'AZURE_TENANT_ID',
  'DOCKER_HOST',
  'DOCKER_CERT_PATH',
  'DOCKER_TLS_VERIFY',
  'FINALIZE_DOCKER_SOCKET',
] as const;

export function isAutopilotWorkerKeyName(name: string): boolean {
  return typeof name === 'string' && name.startsWith(AUTOPILOT_WORKER_KEY_PREFIX);
}

export function autopilotWorkerKeyName(projectId: string, runId: string): string {
  return `${AUTOPILOT_WORKER_KEY_PREFIX}${projectId}:${runId}`;
}

export function autopilotEvaluatorKeyName(projectId: string, runId: string): string {
  return `${autopilotWorkerKeyName(projectId, runId)}:eval`;
}

export function parseAutopilotWorkerKeyName(name: string): AutopilotWorkerScope | null {
  if (!isAutopilotWorkerKeyName(name)) return null;
  const rest = name.slice(AUTOPILOT_WORKER_KEY_PREFIX.length);
  let role: AutopilotWorkerRole = 'implementer';
  let identity = rest;
  if (rest.endsWith(':eval')) {
    role = 'evaluator';
    identity = rest.slice(0, -':eval'.length);
  }
  const sep = identity.lastIndexOf(':');
  if (sep <= 0 || sep === identity.length - 1) return null;
  const projectId = identity.slice(0, sep).trim();
  const runId = identity.slice(sep + 1).trim();
  if (!projectId || !runId) return null;
  return { projectId, runId, role };
}

export function projectIdFromApiPath(pathname: string): string | null {
  const match = /^\/api\/projects\/([^/]+)/.exec(pathname);
  return match?.[1] ?? null;
}

function pathnameOf(req: Request): string {
  const raw = req.originalUrl || req.url || req.path || '';
  const q = raw.indexOf('?');
  return q === -1 ? raw : raw.slice(0, q);
}

const AUTOPILOT_PROJECT_GET = /^\/api\/projects\/([^/]+)\/autopilot\/?$/;
const AUTOPILOT_RUN_GET = /^\/api\/projects\/([^/]+)\/autopilot\/runs\/([^/]+)\/?$/;
const AUTOPILOT_OPERATION_COMPLETE =
  /^\/api\/projects\/([^/]+)\/autopilot\/operations\/([^/]+)\/complete\/?$/;

export function isProtectedAutopilotControlPath(method: string, pathname: string): boolean {
  const m = method.toUpperCase();
  if (m === 'PUT' && /\/autopilot\/config\/?$/.test(pathname)) return true;
  if (m !== 'POST') return false;
  return /\/autopilot\/(start|pause|resume|stop|disable)\/?$/.test(pathname);
}

export function isServerConfigWrite(method: string, pathname: string): boolean {
  const m = method.toUpperCase();
  return (m === 'PATCH' || m === 'PUT' || m === 'POST') && pathname === '/api/config';
}

export function isDeploymentConfigPath(pathname: string): boolean {
  return (
    /\/api\/projects\/[^/]+\/deploy(\/|$)/.test(pathname) ||
    /\/api\/projects\/[^/]+\/deployments(\/|$)/.test(pathname)
  );
}

export interface WorkerOperationResource {
  projectId: string;
  runId: string;
  kind?: string;
}

export interface WorkerRequestResource {
  operation?: WorkerOperationResource | null;
}

export interface WorkerRequestDecision {
  ok: boolean;
  reason?: string;
}

export type AutopilotWorkerOperationLookup = (
  operationId: string,
) => WorkerOperationResource | null;

let workerOperationLookup: AutopilotWorkerOperationLookup | null = null;

export function configureAutopilotWorkerOperationLookup(
  lookup: AutopilotWorkerOperationLookup | null,
): void {
  workerOperationLookup = lookup;
}

export function parseAutopilotOperationCompletePath(pathname: string): string | null {
  const match = AUTOPILOT_OPERATION_COMPLETE.exec(pathname);
  return match?.[2] ? decodeURIComponent(match[2]) : null;
}

export function lookupAutopilotWorkerOperation(
  operationId: string,
): WorkerOperationResource | null {
  return workerOperationLookup?.(operationId) ?? null;
}

export function decideAutopilotWorkerRequest(
  scope: AutopilotWorkerScope,
  method: string,
  pathname: string,
  resource: WorkerRequestResource = {},
): WorkerRequestDecision {
  const m = method.toUpperCase();
  const projectId = projectIdFromApiPath(pathname);
  if (!projectId) {
    return { ok: false, reason: 'Autopilot workers cannot access global Hub endpoints' };
  }
  if (projectId !== scope.projectId) {
    return { ok: false, reason: 'Autopilot workers cannot access other projects' };
  }
  if (isDeploymentConfigPath(pathname)) {
    return { ok: false, reason: 'Autopilot workers cannot change deployment configuration' };
  }
  if (isProtectedAutopilotControlPath(m, pathname) || isServerConfigWrite(m, pathname)) {
    return {
      ok: false,
      reason:
        'Autopilot workers cannot change the brief, evaluator policy, limits, target or run controls',
    };
  }

  if (m === 'GET' && AUTOPILOT_PROJECT_GET.test(pathname)) {
    return { ok: true };
  }

  const runGet = AUTOPILOT_RUN_GET.exec(pathname);
  if (m === 'GET' && runGet) {
    const runId = decodeURIComponent(runGet[2] ?? '');
    if (runId !== scope.runId) {
      return { ok: false, reason: "Autopilot workers cannot access another run's operations" };
    }
    return { ok: true };
  }

  const operationId = parseAutopilotOperationCompletePath(pathname);
  if (m === 'POST' && operationId) {
    const operation = resource.operation;
    if (!operation || operation.projectId !== scope.projectId || operation.runId !== scope.runId) {
      return { ok: false, reason: "Autopilot workers cannot complete another run's operations" };
    }
    if (scope.role === 'evaluator' && operation.kind !== 'evaluate') {
      return {
        ok: false,
        reason: 'Autopilot evaluators cannot write implementation artifacts',
      };
    }
    return { ok: true };
  }

  if (scope.role === 'evaluator') {
    return { ok: false, reason: 'Autopilot evaluators cannot write implementation artifacts' };
  }

  return { ok: false, reason: 'Autopilot workers cannot perform this operation' };
}

export function autopilotWorkerGuard(req: Request, res: Response, next: NextFunction): void {
  const scope = (req as Request & { authAutopilotWorker?: AutopilotWorkerScope })
    .authAutopilotWorker;
  if (!scope) {
    next();
    return;
  }
  const pathname = pathnameOf(req);
  const operationId = parseAutopilotOperationCompletePath(pathname);
  const resource: WorkerRequestResource = {};
  if (operationId) {
    resource.operation = lookupAutopilotWorkerOperation(operationId);
  }
  const decision = decideAutopilotWorkerRequest(scope, req.method, pathname, resource);
  if (!decision.ok) {
    res.status(403).json({ error: decision.reason, code: 'authority_denied' });
    return;
  }
  next();
}

export function applyAutopilotWorkerSpawnEnv(
  env: NodeJS.ProcessEnv,
  input: { token: string; projectId: string; runId: string; role?: AutopilotWorkerRole },
): NodeJS.ProcessEnv {
  env.AGENT_HUB_API_KEY = input.token;
  env.PROJECT_ID = input.projectId;
  env.AGENT_HUB_AUTOPILOT_RUN_ID = input.runId;
  env.AGENT_HUB_AUTOPILOT_PROJECT_ID = input.projectId;
  env.AGENT_HUB_AUTOPILOT_WORKER_ROLE = input.role ?? 'implementer';
  for (const key of CLOUD_AND_SOCKET_ENV_KEYS) {
    delete env[key];
  }
  return env;
}

export interface IssuedAutopilotWorkerCredential {
  keyName: string;
  keyId: string;
  token: string;
}

export type IssueAutopilotWorkerCredential = (input: {
  projectId: string;
  runId: string;
  ownerUserId: string;
  role?: AutopilotWorkerRole;
}) => IssuedAutopilotWorkerCredential;

export type RevokeAutopilotWorkerCredential = (input: {
  projectId: string;
  runId: string;
  ownerUserId?: string | null;
}) => void;

export function mintAutopilotWorkerCredential(input: {
  projectId: string;
  runId: string;
  ownerUserId: string;
  role?: AutopilotWorkerRole;
}): IssuedAutopilotWorkerCredential {
  const keyName =
    input.role === 'evaluator'
      ? autopilotEvaluatorKeyName(input.projectId, input.runId)
      : autopilotWorkerKeyName(input.projectId, input.runId);
  const minted = createApiKey(input.ownerUserId, keyName, 7);
  return { keyName, keyId: minted.id, token: minted.token };
}

export function revokeMintedAutopilotWorkerCredential(input: {
  projectId: string;
  runId: string;
  ownerUserId?: string | null;
}): void {
  if (!input.ownerUserId) return;
  revokeApiKeysByName(input.ownerUserId, autopilotWorkerKeyName(input.projectId, input.runId));
  revokeApiKeysByName(input.ownerUserId, autopilotEvaluatorKeyName(input.projectId, input.runId));
}
