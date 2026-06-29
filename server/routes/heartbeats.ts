import { Router, Request, Response } from 'express';
import type { z } from 'zod';
import { runHeartbeat, rescheduleHeartbeat } from '../heartbeat.js';
import type { AuthenticatedRequest } from '../auth.js';
import { resolveOwnerUserId } from '../session-ownership.js';
import { getUserById } from '../users-store.js';
import { defaultHeartbeatOwnerUserId } from '../heartbeat-ownership.js';
import { canViewProject } from '../project-visibility.js';
import { resolveVisibilityCaller } from '../project-visibility-middleware.js';
import type {
  RouteDeps,
  HeartbeatLogRow,
  HeartbeatStateRow,
  ThreadRow,
  ThreadEntryRow,
  Agent,
  Project,
} from '../types.js';
import { UpdateHeartbeatRequestSchema } from './heartbeats.openapi.js';

interface HeartbeatOverview {
  agentId: string;
  projectId: string | undefined;
  agentName: string;
  color: string | undefined;
  heartbeat: Agent['heartbeat'];
  latestLog: HeartbeatLogRow | null;
  state: HeartbeatStateRow | null;
  owner_user_id: string | null;
  owner_username: string | null;
  shared: 0 | 1;
  can_manage: boolean;
}

interface HeartbeatStateInfo {
  agentId: string;
  agentName: string;
  enabled: boolean;
  interval: string | null;
  next_run_at: string | null;
  last_run_at: string | null;
  overdue: boolean;
  overdue_seconds: number;
}

/**
 * Validate `req.body` against a Zod schema. On failure, writes a 400 with
 * `{error, details}` and returns `undefined`; the handler must `return`
 * immediately. On success, returns the parsed data (typed).
 *
 * Mirrors the helper in `agents.ts` / `board.ts` / `wiki.ts` / `sessions.ts`
 * so the wire shape of validation failures is identical across route groups.
 */
function parseBody<T extends z.ZodTypeAny>(
  schema: T,
  req: Request,
  res: Response,
): z.infer<T> | undefined {
  const result = schema.safeParse(req.body);
  if (!result.success) {
    const first = result.error.issues[0];
    res.status(400).json({
      error: first?.message ?? 'Validation failed',
      details: result.error.issues.map((i) => ({ path: i.path, message: i.message })),
    });
    return undefined;
  }
  return result.data;
}

function coerceShared(raw: boolean | 0 | 1 | '0' | '1'): 0 | 1 {
  if (raw === true || raw === 1 || raw === '1') return 1;
  return 0;
}

function heartbeatOwner(agent: Agent): string | null {
  const owner = agent.heartbeat?.owner_user_id;
  return typeof owner === 'string' && owner.trim() ? owner.trim() : null;
}

function heartbeatShared(agent: Agent): 0 | 1 {
  return agent.heartbeat?.shared ? 1 : 0;
}

function heartbeatIsConfigured(agent: Agent): boolean {
  const heartbeat = agent.heartbeat;
  return Boolean(
    heartbeat?.enabled ||
    heartbeat?.interval?.trim() ||
    heartbeat?.prompt?.trim() ||
    heartbeat?.model?.trim(),
  );
}

function isUnownedHeartbeatPlaceholder(agent: Agent): boolean {
  return !heartbeatOwner(agent) && !heartbeatIsConfigured(agent);
}

function heartbeatConfigIsConfigured(heartbeat: NonNullable<Agent['heartbeat']>): boolean {
  return Boolean(
    heartbeat.enabled ||
    heartbeat.interval?.trim() ||
    heartbeat.prompt?.trim() ||
    heartbeat.model?.trim(),
  );
}

function ensureHeartbeat(agent: Agent): NonNullable<Agent['heartbeat']> {
  if (!agent.heartbeat) {
    agent.heartbeat = { enabled: false, interval: '', prompt: '' };
  }
  if (agent.heartbeat.shared === undefined) {
    agent.heartbeat.shared = 0;
  }
  return agent.heartbeat;
}

function isOwnerCaller(req: AuthenticatedRequest): boolean {
  return req.authRole === 'Owner' || Boolean(req.authViaApiKey) || Boolean(req.authLocalOrgBypass);
}

function canManageHeartbeat(req: AuthenticatedRequest, agent: Agent): boolean {
  if (isOwnerCaller(req)) return true;
  const callerId = resolveOwnerUserId(req);
  if (callerId && isUnownedHeartbeatPlaceholder(agent)) return true;
  const owner = heartbeatOwner(agent);
  return Boolean(callerId && owner && callerId === owner);
}

function canViewHeartbeat(req: AuthenticatedRequest, agent: Agent): boolean {
  if (canManageHeartbeat(req, agent)) return true;
  if (heartbeatShared(agent)) return true;
  if (isUnownedHeartbeatPlaceholder(agent)) return true;
  const callerId = resolveOwnerUserId(req);
  const owner = heartbeatOwner(agent);
  return Boolean(callerId && owner && callerId === owner);
}

function ownerUsername(ownerUserId: string | null): string | null {
  if (!ownerUserId) return null;
  try {
    return getUserById(ownerUserId)?.username ?? null;
  } catch {
    return null;
  }
}

function toHeartbeatOverview(
  req: AuthenticatedRequest,
  agent: Agent,
  stmts: RouteDeps['stmts'],
): HeartbeatOverview {
  const heartbeat = ensureHeartbeat(agent);
  const owner = heartbeatOwner(agent);
  const shared = heartbeatShared(agent);
  return {
    agentId: agent.id,
    projectId: (agent as Agent & { projectId?: string }).projectId,
    agentName: agent.name,
    color: agent.color,
    heartbeat,
    latestLog: (stmts.getLatestHeartbeat.get(agent.id) as HeartbeatLogRow | undefined) || null,
    state: (stmts.getHeartbeatState.get(agent.id) as HeartbeatStateRow | undefined) || null,
    owner_user_id: owner,
    owner_username: ownerUsername(owner),
    shared,
    can_manage: canManageHeartbeat(req, agent),
  };
}

export default function createHeartbeatRoutes(deps: RouteDeps): Router {
  const { allAgents, findAgent, findProject, getEnrichedAgent, saveProjects, stmts } = deps;
  const router = Router();

  function resolveAgentProject(agent: Agent, project?: Project | null): Project | null {
    if (project) return project;
    const projectId = (agent as Agent & { projectId?: string }).projectId;
    if (projectId) return findProject(projectId);
    return findAgent(agent.id)?.project ?? null;
  }

  function canViewHeartbeatWithProject(
    req: AuthenticatedRequest,
    agent: Agent,
    project?: Project | null,
  ): boolean {
    const resolvedProject = resolveAgentProject(agent, project);
    if (!resolvedProject || !canViewProject(resolvedProject, resolveVisibilityCaller(req))) {
      return false;
    }
    return canViewHeartbeat(req, agent);
  }

  router.get('/api/heartbeats/:agentId/thread', (req: Request, res: Response) => {
    const found = findAgent(req.params.agentId as string);
    if (!found) return res.status(404).json({ error: 'Agent not found' });
    if (!canViewHeartbeatWithProject(req as AuthenticatedRequest, found.agent, found.project)) {
      return res.status(404).json({ error: 'Agent not found' });
    }

    const { project } = found;
    const thread = stmts.getThreadBySource.get(project.id, 'heartbeat', req.params.agentId) as
      | ThreadRow
      | undefined;
    if (!thread) {
      return res.json({ thread: null, entries: [] });
    }

    const entries = stmts.getThreadEntries.all(thread.id) as ThreadEntryRow[];
    res.json({ thread, entries });
  });

  router.get('/api/heartbeats', (req: Request, res: Response) => {
    const authedReq = req as AuthenticatedRequest;
    const configs: HeartbeatOverview[] = allAgents()
      .filter((agent) => canViewHeartbeatWithProject(authedReq, agent))
      .map((agent) => toHeartbeatOverview(authedReq, agent, stmts));
    res.json(configs);
  });

  router.get('/api/heartbeats/state', (req: Request, res: Response) => {
    const authedReq = req as AuthenticatedRequest;
    const now = Date.now();
    const rows: HeartbeatStateInfo[] = allAgents()
      .filter((agent) => canViewHeartbeatWithProject(authedReq, agent))
      .filter((a) => a.heartbeat?.enabled || a.heartbeat?.interval)
      .map((a) => {
        const state = (stmts.getHeartbeatState.get(a.id) as HeartbeatStateRow | undefined) || null;
        const nextMs = state?.next_run_at ? Date.parse(state.next_run_at) : null;
        return {
          agentId: a.id,
          agentName: a.name,
          enabled: !!a.heartbeat?.enabled,
          interval: a.heartbeat?.interval || null,
          next_run_at: state?.next_run_at || null,
          last_run_at: state?.last_run_at || null,
          overdue: nextMs != null && Number.isFinite(nextMs) ? nextMs < now : false,
          overdue_seconds:
            nextMs != null && Number.isFinite(nextMs) && nextMs < now
              ? Math.round((now - nextMs) / 1000)
              : 0,
        };
      });
    res.json(rows);
  });

  router.get('/api/heartbeats/:agentId/logs', (req: Request, res: Response) => {
    const found = findAgent(req.params.agentId as string);
    if (
      !found ||
      !canViewHeartbeatWithProject(req as AuthenticatedRequest, found.agent, found.project)
    ) {
      return res.status(404).json({ error: 'Agent not found' });
    }
    const limit = parseInt(req.query.limit as string) || 50;
    const logs = stmts.getHeartbeatLogs.all(req.params.agentId, limit) as HeartbeatLogRow[];
    res.json(logs);
  });

  router.put('/api/heartbeats/:agentId', (req: Request, res: Response) => {
    const found = findAgent(req.params.agentId as string);
    if (!found) return res.status(404).json({ error: 'Agent not found' });
    const { agent } = found;
    const authedReq = req as AuthenticatedRequest;
    if (!canViewHeartbeatWithProject(authedReq, agent, found.project)) {
      return res.status(404).json({ error: 'Agent not found' });
    }
    if (!canManageHeartbeat(authedReq, agent)) {
      return res
        .status(403)
        .json({ error: 'Only the heartbeat owner or an org Owner can update it.' });
    }

    const parsed = parseBody(UpdateHeartbeatRequestSchema, req, res);
    if (!parsed) return;
    const { enabled, interval, prompt, model, shared } = parsed;

    // `model` uses an explicit-undefined check so the caller can clear the
    // override by sending `""` or `null` (mapped to undefined) without losing
    // it under the truthy-fallback logic the other fields use.
    let nextModel = agent.heartbeat?.model;
    if (model !== undefined) {
      const trimmed = typeof model === 'string' ? model.trim() : '';
      nextModel = trimmed || undefined;
    }

    const existingHeartbeat = ensureHeartbeat(agent);
    let nextShared: 0 | 1 = heartbeatShared(agent);
    if (Object.prototype.hasOwnProperty.call(req.body, 'shared') && shared !== undefined) {
      nextShared = coerceShared(shared);
    }

    const nextHeartbeat: NonNullable<Agent['heartbeat']> = {
      enabled: enabled !== undefined ? enabled : (existingHeartbeat.enabled ?? false),
      interval: interval || existingHeartbeat.interval || '',
      prompt: prompt || existingHeartbeat.prompt || '',
      owner_user_id: null,
      shared: nextShared,
      ...(nextModel ? { model: nextModel } : {}),
    };
    nextHeartbeat.owner_user_id =
      heartbeatOwner(agent) ??
      (heartbeatConfigIsConfigured(nextHeartbeat)
        ? (resolveOwnerUserId(authedReq) ?? defaultHeartbeatOwnerUserId())
        : null);
    agent.heartbeat = nextHeartbeat;

    saveProjects();
    rescheduleHeartbeat(getEnrichedAgent(agent.id)!);
    res.json(toHeartbeatOverview(authedReq, agent, stmts));
  });

  router.post('/api/heartbeats/:agentId/run', async (req: Request, res: Response) => {
    const enriched = getEnrichedAgent(req.params.agentId as string);
    if (!enriched) return res.status(404).json({ error: 'Agent not found' });
    const found = findAgent(req.params.agentId as string);
    if (
      !found ||
      !canViewHeartbeatWithProject(req as AuthenticatedRequest, found.agent, found.project)
    ) {
      return res.status(404).json({ error: 'Agent not found' });
    }
    if (!canManageHeartbeat(req as AuthenticatedRequest, found.agent)) {
      return res
        .status(403)
        .json({ error: 'Only the heartbeat owner or an org Owner can run it.' });
    }
    if (!enriched.heartbeat?.prompt) {
      return res.status(400).json({ error: 'No heartbeat prompt configured' });
    }

    const logEntry = stmts.addHeartbeatLog.run(enriched.id, enriched.heartbeat.prompt, 'running');
    const logId = logEntry.lastInsertRowid;
    res.json({ logId, status: 'running' });

    runHeartbeat(enriched).catch((err: Error) => {
      console.error(`Manual heartbeat failed for ${enriched.name}:`, err);
    });
  });

  return router;
}
