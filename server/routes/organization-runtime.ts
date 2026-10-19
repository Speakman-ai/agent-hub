import { Router, type Request, type Response } from 'express';
import type { AuthenticatedRequest } from '../auth.js';
import type { RouteDeps } from '../types.js';
import { getActiveOrgId } from '../orgs.js';
import { getBusinessOrganization } from '../business-organizations-store.js';
import { organizationAccess, resolveOrganizationCaller } from '../business-organizations-access.js';
import { ensureOrganizationWorkspace } from '../organization-workspaces.js';
import { saveProjects } from '../project-model.js';
import { createOrganizationSession, organizationAgentForUser } from '../organization-sessions.js';
import { userOwnsSession } from '../session-ownership.js';
import { organizationSessionWorkspace } from '../organization-capabilities.js';
import { appendOrganizationMemory, readOrganizationMemory } from '../organization-memory.js';
import {
  OrganizationAgentParams,
  OrganizationAgentPatch,
  OrganizationRuntimeAgent,
  OrganizationSessionBody,
  OrganizationMemoryBody,
} from './organization-runtime.openapi.js';
import { OrganizationParams } from './organizations.openapi.js';

export default function createOrganizationRuntimeRoutes(
  deps: Pick<RouteDeps, 'stmts' | 'config' | 'broadcast'>,
): Router {
  const router = Router();
  function resolve(req: Request, res: Response) {
    const auth = req as AuthenticatedRequest;
    if (!auth.authUserId || !auth.authOrgId) {
      res.status(401).json({ error: 'User identity required' });
      return null;
    }
    const caller = resolveOrganizationCaller(auth.authOrgId, auth.authUserId);
    const id = String(req.params.organizationId);
    if (
      !caller ||
      caller.serverId !== getActiveOrgId() ||
      !getBusinessOrganization(caller.serverId, id) ||
      !organizationAccess(caller, id).canView
    ) {
      res.status(404).json({ error: 'Organization not found' });
      return null;
    }
    return {
      caller,
      access: organizationAccess(caller, id),
      project: ensureOrganizationWorkspace(caller.serverId, id),
    };
  }
  router.get('/api/organizations/:organizationId/agents', (req, res) => {
    if (!OrganizationParams.safeParse(req.params).success)
      return res.status(400).json({ error: 'Invalid request' });
    const context = resolve(req, res);
    if (!context) return;
    const agents = context.project.agents.filter(
      (a) =>
        context.access.canManage ||
        (a.organizationScope?.enabled && !a.organizationScope.archivedAt),
    );
    res.json({ agents: agents.map((agent) => OrganizationRuntimeAgent.parse(agent)) });
  });
  router.patch('/api/organizations/:organizationId/agents/:agentId', (req, res) => {
    const body = OrganizationAgentPatch.safeParse(req.body);
    if (!OrganizationAgentParams.safeParse(req.params).success || !body.success)
      return res.status(400).json({ error: 'Invalid request' });
    const context = resolve(req, res);
    if (!context) return;
    if (!context.access.canManage)
      return res.status(403).json({ error: 'Organization administrator required' });
    const agent = context.project.agents.find((a) => a.id === req.params.agentId);
    if (!agent?.organizationScope) return res.status(404).json({ error: 'Agent not found' });
    if (
      body.data.model &&
      !deps.config.engineValidModels?.[agent.engine]?.includes(body.data.model)
    )
      return res.status(400).json({ error: 'Invalid model for agent engine' });
    const { enabled, archived, ...fields } = body.data;
    Object.assign(agent, fields);
    if (enabled !== undefined) agent.organizationScope.enabled = enabled;
    if (archived !== undefined)
      agent.organizationScope.archivedAt = archived ? new Date().toISOString() : null;
    saveProjects();
    deps.broadcast({
      type: 'organization_updated',
      serverId: context.caller.serverId,
      organizationId: context.project.organizationId,
      action: 'agent_updated',
    });
    res.json({ agent: OrganizationRuntimeAgent.parse(agent) });
  });
  router.post('/api/organizations/:organizationId/agents/:agentId/sessions', (req, res) => {
    const body = OrganizationSessionBody.safeParse(req.body);
    if (!OrganizationAgentParams.safeParse(req.params).success || !body.success)
      return res.status(400).json({ error: 'Invalid request' });
    const context = resolve(req, res);
    if (!context) return;
    const args = {
      serverId: context.caller.serverId,
      organizationId: String(req.params.organizationId),
      agentId: String(req.params.agentId),
      userId: context.caller.userId,
    };
    const found = organizationAgentForUser(
      args.serverId,
      args.organizationId,
      args.agentId,
      args.userId,
    );
    if (!found) return res.status(404).json({ error: 'Organization agent unavailable' });
    const session = createOrganizationSession({
      ...args,
      stmts: deps.stmts,
      config: deps.config,
      name: body.data.name,
    });
    deps.broadcast({ type: 'session_created', sessionId: session.id, agentId: found.agent.id });
    res.status(201).json({ session, agent: OrganizationRuntimeAgent.parse(found.agent) });
  });
  function memoryAllowed(req: Request, res: Response): boolean {
    const id = String(req.params.sessionId);
    try {
      if (userOwnsSession(req as AuthenticatedRequest, id) && organizationSessionWorkspace(id))
        return true;
    } catch {
      /* Removed agents retain history but cannot supply runtime memory. */
    }
    res.status(404).json({ error: 'Organization session unavailable' });
    return false;
  }
  router.get('/api/sessions/:sessionId/organization-memory', (req, res) => {
    if (!memoryAllowed(req, res)) return;
    try {
      res.json({ memories: readOrganizationMemory(String(req.params.sessionId)) });
    } catch {
      res.status(404).json({ error: 'Organization memory unavailable' });
    }
  });
  router.post('/api/sessions/:sessionId/organization-memory', (req, res) => {
    const body = OrganizationMemoryBody.safeParse(req.body);
    if (!body.success) return res.status(400).json({ error: 'Invalid request' });
    if (!memoryAllowed(req, res)) return;
    try {
      res
        .status(201)
        .json({ memory: appendOrganizationMemory(String(req.params.sessionId), body.data) });
    } catch {
      res.status(404).json({ error: 'Organization memory unavailable' });
    }
  });
  return router;
}
