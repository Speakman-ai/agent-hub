import { Router } from 'express';
import type { AuthenticatedRequest } from '../auth.js';
import { z, registerPath } from '../openapi/registry.js';
import {
  renewOrganizationCapability,
  verifyOrganizationCapability,
} from '../organization-capabilities.js';
import { findProjectForServer } from '../project-model.js';

const SessionParams = z.object({ sessionId: z.string().min(1) });
const OrganizationParams = z.object({ organizationId: z.string().min(1) });
const Pagination = z
  .object({
    offset: z.coerce.number().int().min(0).default(0),
    limit: z.coerce.number().int().min(1).max(100).default(25),
  })
  .strict();
const Renewed = z.object({ token: z.string(), expiresAt: z.number() });
const Context = z.object({
  serverId: z.string(),
  organizationId: z.string(),
  sessionId: z.string(),
  agentId: z.string(),
  timestamp: z.string(),
  offset: z.number(),
  nextOffset: z.number().nullable(),
  projects: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      agents: z.array(z.object({ id: z.string(), name: z.string() })),
    }),
  ),
});
const error = { description: 'Capability missing, expired, revoked or out of scope.' };
registerPath({
  method: 'post',
  path: '/api/sessions/{sessionId}/organization-capability/renew',
  tags: ['Organizations'],
  summary: 'Renew an organization session capability against current access',
  request: { params: SessionParams },
  responses: {
    200: {
      description: 'Rotated capability. The previous token is revoked.',
      content: { 'application/json': { schema: Renewed } },
    },
    401: error,
    403: error,
  },
});
registerPath({
  method: 'get',
  path: '/api/organizations/{organizationId}/capability-context',
  tags: ['Organizations'],
  summary: 'Discover projects and agent roster within the current capability scope',
  request: { params: OrganizationParams, query: Pagination },
  responses: {
    200: {
      description: 'Paginated authorized project identities, with source and timestamp.',
      content: { 'application/json': { schema: Context } },
    },
    400: { description: 'Invalid pagination' },
    401: error,
    403: error,
  },
});

export default function createOrganizationCapabilityRoutes(): Router {
  const router = Router();
  router.post('/api/sessions/:sessionId/organization-capability/renew', (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const authenticated = req as AuthenticatedRequest;
    if (
      !SessionParams.safeParse(req.params).success ||
      authenticated.authOrganizationCapability?.sessionId !== req.params.sessionId ||
      !authenticated.authOrganizationToken
    ) {
      res.status(403).json({ error: 'Organization capability required' });
      return;
    }
    const token = renewOrganizationCapability(authenticated.authOrganizationToken);
    const grant = token && verifyOrganizationCapability(token);
    if (!token || !grant) {
      res.status(401).json({ error: 'Organization capability revoked' });
      return;
    }
    res.json(Renewed.parse({ token, expiresAt: grant.expiresAt }));
  });
  router.get('/api/organizations/:organizationId/capability-context', (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const authenticated = req as AuthenticatedRequest;
    const grant =
      authenticated.authOrganizationToken &&
      verifyOrganizationCapability(authenticated.authOrganizationToken);
    if (
      !OrganizationParams.safeParse(req.params).success ||
      !grant ||
      grant.organizationId !== req.params.organizationId ||
      !grant.tools.includes('projects:read')
    ) {
      res.status(403).json({ error: 'Organization capability required' });
      return;
    }
    const parsed = Pagination.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid pagination' });
      return;
    }
    const { offset, limit } = parsed.data;
    const projects = grant.projectIds.slice(offset, offset + limit).map((id) => {
      const project = findProjectForServer(grant.serverId, id)!;
      return {
        id,
        name: project.name,
        agents: project.agents.map((agent) => ({ id: agent.id, name: agent.name })),
      };
    });
    res.json(
      Context.parse({
        serverId: grant.serverId,
        organizationId: grant.organizationId,
        sessionId: grant.sessionId,
        agentId: grant.agentId,
        timestamp: new Date().toISOString(),
        offset,
        nextOffset: offset + limit < grant.projectIds.length ? offset + limit : null,
        projects,
      }),
    );
  });
  return router;
}
