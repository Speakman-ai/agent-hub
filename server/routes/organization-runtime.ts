import { Router, type Request, type Response } from 'express';
import type { AuthenticatedRequest } from '../auth.js';
import type { Agent, RouteDeps } from '../types.js';
import { getActiveOrgId } from '../orgs.js';
import { getBusinessOrganization } from '../business-organizations-store.js';
import { organizationAccess, resolveOrganizationCaller } from '../business-organizations-access.js';
import { ensureOrganizationWorkspace } from '../organization-workspaces.js';
import {
  createOrganizationAgent,
  organizationAgentView,
  updateOrganizationAgent,
  OrganizationAgentError,
} from '../organization-agents.js';
import { ORGANIZATION_AGENT_TEMPLATES } from '../organization-agent-templates.js';
import { createOrganizationSession, organizationAgentForUser } from '../organization-sessions.js';
import { userOwnsSession } from '../session-ownership.js';
import { organizationSessionWorkspace } from '../organization-capabilities.js';
import { appendOrganizationMemory, readOrganizationMemory } from '../organization-memory.js';
import {
  OrganizationAgentParams,
  OrganizationAgentPatch,
  OrganizationAgentCreate,
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
  type Context = NonNullable<ReturnType<typeof resolve>>;
  const usable = (agent: Agent) =>
    Boolean(agent.organizationScope?.enabled && !agent.organizationScope.archivedAt);
  const view = (context: Context, agent: Agent) =>
    OrganizationRuntimeAgent.parse(organizationAgentView(context.caller, context.project, agent));
  function fail(res: Response, err: unknown) {
    if (err instanceof OrganizationAgentError)
      return res.status(err.status).json({ error: err.message });
    throw err;
  }
  function changed(context: Context, action: string, agentId: string) {
    deps.broadcast({
      type: 'organization_updated',
      serverId: context.caller.serverId,
      organizationId: context.project.organizationId,
      action,
      agentId,
    });
  }
  router.get('/api/organizations/:organizationId/agent-templates', (req, res) => {
    if (!OrganizationParams.safeParse(req.params).success)
      return res.status(400).json({ error: 'Invalid request' });
    if (!resolve(req, res)) return;
    res.json({ templates: ORGANIZATION_AGENT_TEMPLATES });
  });
  router.get('/api/organizations/:organizationId/agents', (req, res) => {
    if (!OrganizationParams.safeParse(req.params).success)
      return res.status(400).json({ error: 'Invalid request' });
    const context = resolve(req, res);
    if (!context) return;
    const agents = context.project.agents.filter(
      (a) => a.organizationScope && (context.access.canManage || usable(a)),
    );
    res.json({ agents: agents.map((agent) => view(context, agent)) });
  });
  router.post('/api/organizations/:organizationId/agents', (req, res) => {
    const body = OrganizationAgentCreate.safeParse(req.body);
    if (!OrganizationParams.safeParse(req.params).success || !body.success)
      return res.status(400).json({ error: 'Invalid request' });
    const context = resolve(req, res);
    if (!context) return;
    if (!context.access.canManage)
      return res.status(403).json({ error: 'Organization administrator required' });
    try {
      const agent = createOrganizationAgent(
        context.caller,
        context.project,
        deps.config,
        body.data,
      );
      changed(context, 'agent_created', agent.id);
      res.status(201).json({ agent: view(context, agent) });
    } catch (err) {
      fail(res, err);
    }
  });
  function findOrganizationAgent(context: Context, agentId: string) {
    const agent = context.project.agents.find((a) => a.id === agentId);
    if (!agent?.organizationScope) return null;
    return context.access.canManage || usable(agent) ? agent : null;
  }
  router.get('/api/organizations/:organizationId/agents/:agentId', (req, res) => {
    if (!OrganizationAgentParams.safeParse(req.params).success)
      return res.status(400).json({ error: 'Invalid request' });
    const context = resolve(req, res);
    if (!context) return;
    const agent = findOrganizationAgent(context, String(req.params.agentId));
    if (!agent) return res.status(404).json({ error: 'Agent not found' });
    res.json({ agent: view(context, agent) });
  });
  router.patch('/api/organizations/:organizationId/agents/:agentId', (req, res) => {
    const body = OrganizationAgentPatch.safeParse(req.body);
    if (!OrganizationAgentParams.safeParse(req.params).success || !body.success)
      return res.status(400).json({ error: 'Invalid request' });
    const context = resolve(req, res);
    if (!context) return;
    if (!context.access.canManage)
      return res.status(403).json({ error: 'Organization administrator required' });
    const agent = findOrganizationAgent(context, String(req.params.agentId));
    if (!agent) return res.status(404).json({ error: 'Agent not found' });
    try {
      updateOrganizationAgent(context.caller, context.project, agent, deps.config, body.data);
      changed(context, 'agent_updated', agent.id);
      res.json({ agent: view(context, agent) });
    } catch (err) {
      fail(res, err);
    }
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
