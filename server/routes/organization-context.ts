import { Router, type Request, type Response } from 'express';
import type { AuthenticatedRequest } from '../auth.js';
import { resolveOrganizationCaller } from '../business-organizations-access.js';
import {
  decodeSearchCursor,
  getProjectRecord,
  InvalidContextCursor,
  listProjectResource,
  OrganizationContextNotFound,
  organizationOverview,
  organizationServerSummary,
  scopeForMember,
  scopeFromCapability,
  searchCursorBinding,
  searchOrganization,
  type OrganizationReadScope,
} from '../organization-context.js';
import {
  ContextParams,
  OverviewQuery,
  RecordParams,
  ResourceParams,
  ResourceQuery,
  SearchQuery,
  SummaryQuery,
} from './organization-context.openapi.js';

/** Resolves the read scope fresh on every request; nothing is trusted from a previous call. */
function readScope(req: Request, res: Response): OrganizationReadScope | null {
  res.setHeader('Cache-Control', 'no-store');
  const authenticated = req as AuthenticatedRequest;
  const organizationId = String(req.params.organizationId);
  const grant = authenticated.authOrganizationCapability;
  if (grant) {
    if (grant.organizationId !== organizationId || !grant.tools.includes('projects:read')) {
      res.status(403).json({ error: 'Organization capability required' });
      return null;
    }
    const scope = scopeFromCapability(grant);
    if (!scope) res.status(401).json({ error: 'Organization capability revoked' });
    return scope;
  }
  if (!authenticated.authUserId || !authenticated.authOrgId) {
    res.status(401).json({ error: 'An authenticated user identity is required' });
    return null;
  }
  const caller = resolveOrganizationCaller(authenticated.authOrgId, authenticated.authUserId);
  const scope = caller && scopeForMember(caller, organizationId);
  if (!scope) res.status(404).json({ error: 'Organization not found' });
  return scope || null;
}

function handle(res: Response, build: () => unknown): void {
  try {
    res.json(build());
  } catch (error) {
    if (error instanceof InvalidContextCursor) {
      res.status(400).json({ error: error.message });
      return;
    }
    if (error instanceof OrganizationContextNotFound) {
      res.status(404).json({ error: error.message });
      return;
    }
    throw error;
  }
}

export default function createOrganizationContextRoutes(): Router {
  const router = Router();
  // Literal path: must be mounted before the /api/organizations/:organizationId routes.
  router.get('/api/organizations/summary', (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const authenticated = req as AuthenticatedRequest;
    if (authenticated.authOrganizationCapability) {
      res.status(403).json({ error: 'Operation unavailable to organization capability' });
      return;
    }
    if (!authenticated.authUserId || !authenticated.authOrgId) {
      res.status(401).json({ error: 'An authenticated user identity is required' });
      return;
    }
    const query = SummaryQuery.safeParse(req.query);
    if (!query.success) {
      res.status(400).json({ error: 'Invalid request' });
      return;
    }
    const caller = resolveOrganizationCaller(authenticated.authOrgId, authenticated.authUserId);
    if (!caller) {
      res.status(404).json({ error: 'Server not found' });
      return;
    }
    res.json(organizationServerSummary(caller, query.data));
  });

  router.get('/api/organizations/:organizationId/context', (req, res) => {
    const query = OverviewQuery.safeParse(req.query);
    if (!ContextParams.safeParse(req.params).success || !query.success) {
      res.status(400).json({ error: 'Invalid request' });
      return;
    }
    const scope = readScope(req, res);
    if (scope) handle(res, () => organizationOverview(scope, query.data));
  });

  router.get('/api/organizations/:organizationId/context/search', (req, res) => {
    const query = SearchQuery.safeParse(req.query);
    if (!ContextParams.safeParse(req.params).success || !query.success) {
      res.status(400).json({ error: 'Invalid request' });
      return;
    }
    const { cursor: rawCursor, ...search } = query.data;
    const scope = readScope(req, res);
    if (!scope) return;
    const cursor =
      rawCursor === undefined
        ? undefined
        : decodeSearchCursor(rawCursor, searchCursorBinding(scope, search.q, search.types));
    if (cursor === null) {
      res.status(400).json({ error: 'Invalid cursor' });
      return;
    }
    handle(res, () => searchOrganization(scope, { ...search, cursor }));
  });

  router.get(
    '/api/organizations/:organizationId/context/projects/:projectId/:resource',
    (req, res) => {
      const params = ResourceParams.safeParse(req.params);
      const query = ResourceQuery.safeParse(req.query);
      if (!params.success || !query.success) {
        res.status(400).json({ error: 'Invalid request' });
        return;
      }
      const scope = readScope(req, res);
      const { offset, limit, cursor, ...filter } = query.data;
      if (scope)
        handle(res, () =>
          listProjectResource(
            scope,
            params.data.projectId,
            params.data.resource,
            { offset, limit },
            filter,
            cursor,
          ),
        );
    },
  );

  router.get(
    '/api/organizations/:organizationId/context/projects/:projectId/:resource/:recordId',
    (req, res) => {
      const params = RecordParams.safeParse(req.params);
      if (!params.success || Object.keys(req.query).length) {
        res.status(400).json({ error: 'Invalid request' });
        return;
      }
      const scope = readScope(req, res);
      if (scope)
        handle(res, () =>
          getProjectRecord(
            scope,
            params.data.projectId,
            params.data.resource,
            params.data.recordId,
          ),
        );
    },
  );
  return router;
}
