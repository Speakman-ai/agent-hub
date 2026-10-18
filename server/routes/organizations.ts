import { Router, type Request, type Response, type NextFunction } from 'express';
import type { AuthenticatedRequest } from '../auth.js';
import type { BusinessOrganizationRow, RouteDeps } from '../types.js';
import {
  archiveBusinessOrganization,
  attachBusinessOrganizationProject,
  createBusinessOrganization,
  detachBusinessOrganizationProject,
  getBusinessOrganization,
  listBusinessOrganizationMembers,
  listBusinessOrganizationProjectIds,
  listBusinessOrganizations,
  removeBusinessOrganizationMember,
  renameBusinessOrganization,
  setBusinessOrganizationMember,
  LastOrganizationOwnerError,
} from '../business-organizations-store.js';
import {
  organizationAccess,
  resolveOrganizationCaller,
  visibleOrganizationProject,
  type OrganizationCaller,
} from '../business-organizations-access.js';
import { getMembershipRole, listMembersForOrg } from '../memberships-store.js';
import { getVisibility } from '../project-visibility.js';
import {
  OrganizationParams,
  OrganizationMemberParams,
  OrganizationProjectParams,
  OrganizationNameBody,
  OrganizationMemberBody,
  OrganizationQuery,
} from './organizations.openapi.js';
import type { z } from '../openapi/registry.js';

function summary(organization: BusinessOrganizationRow, caller: OrganizationCaller) {
  const { role, canManage } = organizationAccess(caller, organization.id);
  return {
    id: organization.id,
    serverId: organization.server_id,
    name: organization.name,
    createdBy: organization.created_by,
    createdAt: organization.created_at,
    updatedAt: organization.updated_at,
    role,
    canManage,
  };
}

export default function createOrganizationsRoutes(deps: Pick<RouteDeps, 'broadcast'>): Router {
  const router = Router();
  // Each handler is synchronous: current identity, authorization and mutations execute
  // together without yielding to a Server switch. Never infer identity from a session header.
  function route(
    params: z.ZodType | null,
    manage: boolean,
    handler: (
      req: Request,
      res: Response,
      caller: OrganizationCaller,
      organization?: BusinessOrganizationRow,
    ) => void,
  ) {
    return (req: Request, res: Response, next: NextFunction): void => {
      try {
        const authenticated = req as AuthenticatedRequest;
        if (!authenticated.authUserId || !authenticated.authOrgId) {
          res.status(401).json({ error: 'An authenticated user identity is required' });
          return;
        }
        const caller = resolveOrganizationCaller(authenticated.authOrgId, authenticated.authUserId);
        if (!caller) {
          res.status(404).json({ error: 'Server not found' });
          return;
        }
        if (
          !OrganizationQuery.safeParse(req.query).success ||
          (params && !params.safeParse(req.params).success)
        ) {
          res.status(400).json({ error: 'Invalid request' });
          return;
        }
        let organization: BusinessOrganizationRow | undefined;
        if (params) {
          const id = req.params.organizationId as string;
          organization = getBusinessOrganization(caller.serverId, id) ?? undefined;
          const access = organizationAccess(caller, id);
          if (!organization || !access.canView) {
            res.status(404).json({ error: 'Organization not found' });
            return;
          }
          if (manage && !access.canManage) {
            res.status(403).json({ error: 'Organization administration requires Owner/Admin' });
            return;
          }
        }
        handler(req, res, caller, organization);
      } catch (error) {
        if (error instanceof LastOrganizationOwnerError) {
          res.status(409).json({ error: error.message });
          return;
        }
        next(error);
      }
    };
  }
  function emit(
    caller: OrganizationCaller,
    organizationId: string,
    type: 'organization_updated' | 'organization_invalidated',
    action: string,
    projectId?: string,
  ) {
    deps.broadcast({
      type,
      serverId: caller.serverId,
      organizationId,
      action,
      ...(projectId ? { projectId } : {}),
    });
  }
  function revoked(
    caller: OrganizationCaller,
    organizationId: string,
    userId: string,
    reason: 'archived' | 'member_removed',
  ) {
    deps.broadcast({
      type: 'organization_access_revoked',
      serverId: caller.serverId,
      organizationId,
      userId,
      reason,
    });
  }

  router.get(
    '/api/organizations',
    route(null, false, (_req, res, caller) => {
      res.json({
        organizations: listBusinessOrganizations(caller.serverId)
          .filter((o) => organizationAccess(caller, o.id).canView)
          .map((o) => summary(o, caller)),
      });
    }),
  );
  router.post(
    '/api/organizations',
    route(null, false, (req, res, caller) => {
      const body = OrganizationNameBody.safeParse(req.body);
      if (!body.success) {
        res.status(400).json({ error: 'Invalid organization name' });
        return;
      }
      const organization = createBusinessOrganization({
        serverId: caller.serverId,
        name: body.data.name,
        createdBy: caller.userId,
      });
      emit(caller, organization.id, 'organization_updated', 'created');
      res.status(201).json({ organization: summary(organization, caller) });
    }),
  );
  router.get(
    '/api/organizations/:organizationId',
    route(OrganizationParams, false, (_req, res, caller, organization) => {
      res.json({ organization: summary(organization!, caller) });
    }),
  );
  router.patch(
    '/api/organizations/:organizationId',
    route(OrganizationParams, true, (req, res, caller, organization) => {
      const body = OrganizationNameBody.safeParse(req.body);
      if (!body.success) {
        res.status(400).json({ error: 'Invalid organization name' });
        return;
      }
      const updated = renameBusinessOrganization(caller.serverId, organization!.id, body.data.name);
      emit(caller, updated.id, 'organization_updated', 'renamed');
      res.json({ organization: summary(updated, caller) });
    }),
  );
  router.delete(
    '/api/organizations/:organizationId',
    route(OrganizationParams, true, (_req, res, caller, organization) => {
      const id = organization!.id;
      // Capture recipients before membership removal. Each revocation is minimal and user-specific.
      const recipients = new Set([
        ...listBusinessOrganizationMembers(caller.serverId, id).map((m) => m.user_id),
        ...listMembersForOrg(caller.serverId)
          .filter((m) => m.role === 'Owner' || m.role === 'Admin')
          .map((m) => m.userId),
      ]);
      archiveBusinessOrganization(caller.serverId, id);
      for (const userId of recipients) revoked(caller, id, userId, 'archived');
      res.json({ ok: true });
    }),
  );
  router.get(
    '/api/organizations/:organizationId/members',
    route(OrganizationParams, false, (_req, res, caller, organization) => {
      const users = new Map(listMembersForOrg(caller.serverId).map((m) => [m.userId, m.username]));
      res.json({
        members: listBusinessOrganizationMembers(caller.serverId, organization!.id).map((m) => ({
          userId: m.user_id,
          username: users.get(m.user_id)!,
          role: m.role,
          createdAt: m.created_at,
        })),
      });
    }),
  );
  router.put(
    '/api/organizations/:organizationId/members/:userId',
    route(OrganizationMemberParams, true, (req, res, caller, organization) => {
      const body = OrganizationMemberBody.safeParse(req.body);
      if (!body.success) {
        res.status(400).json({ error: 'Invalid organization role' });
        return;
      }
      const userId = req.params.userId as string;
      if (!getMembershipRole(userId, caller.serverId)) {
        res.status(404).json({ error: 'Member not found' });
        return;
      }
      setBusinessOrganizationMember(caller.serverId, organization!.id, userId, body.data.role);
      emit(caller, organization!.id, 'organization_invalidated', 'membership_changed');
      res.json({ ok: true });
    }),
  );
  router.delete(
    '/api/organizations/:organizationId/members/:userId',
    route(OrganizationMemberParams, true, (req, res, caller, organization) => {
      const userId = req.params.userId as string;
      if (!getMembershipRole(userId, caller.serverId)) {
        res.status(404).json({ error: 'Member not found' });
        return;
      }
      if (removeBusinessOrganizationMember(caller.serverId, organization!.id, userId)) {
        revoked(caller, organization!.id, userId, 'member_removed');
        emit(caller, organization!.id, 'organization_invalidated', 'membership_changed');
      }
      res.json({ ok: true });
    }),
  );
  router.get(
    '/api/organizations/:organizationId/projects',
    route(OrganizationParams, false, (_req, res, caller, organization) => {
      const projects = listBusinessOrganizationProjectIds(
        caller.serverId,
        organization!.id,
      ).flatMap((id) => {
        const project = visibleOrganizationProject(caller, id);
        return project
          ? [{ id: project.id, name: project.name, visibility: getVisibility(project) }]
          : [];
      });
      res.json({ projects });
    }),
  );
  function changeProject(attach: boolean) {
    return route(OrganizationProjectParams, true, (req, res, caller, organization) => {
      const projectId = req.params.projectId as string;
      if (!visibleOrganizationProject(caller, projectId)) {
        res.status(404).json({ error: 'Project not found' });
        return;
      }
      const changed = (
        attach ? attachBusinessOrganizationProject : detachBusinessOrganizationProject
      )(caller.serverId, organization!.id, projectId);
      if (changed)
        emit(
          caller,
          organization!.id,
          'organization_invalidated',
          attach ? 'project_attached' : 'project_detached',
          projectId,
        );
      res.json({ ok: true });
    });
  }
  router.put('/api/organizations/:organizationId/projects/:projectId', changeProject(true));
  router.delete('/api/organizations/:organizationId/projects/:projectId', changeProject(false));
  return router;
}
