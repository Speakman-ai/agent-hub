import { repairOrganizationWorkspaces } from '../organization-workspaces.js';
import { Router, Request, Response, type NextFunction } from 'express';
import { mkdirSync } from 'fs';
import {
  getAllOrgs,
  getOrg,
  createOrg as createOrgRecord,
  updateOrg as updateOrgRecord,
  deleteOrg as deleteOrgRecord,
  orgDataDir,
  getActiveOrgId,
  setActiveOrgId,
} from '../orgs.js';
import { createMembership, getMembershipRole, listMembersForOrg } from '../memberships-store.js';
import type { AuthenticatedRequest } from '../auth.js';
import { getAuthRecord } from '../auth-store.js';
import config from '../config.js';
import { backfillSkillBuilderAgents } from '../migrations/backfill-skill-builder-agents.js';
import { backfillQaAgents } from '../migrations/backfill-qa-agents.js';
import type { OrgRow, RouteDeps } from '../types.js';
import { toServerConnection } from '../server-connections.js';
import {
  CreateServerRequestSchema,
  UpdateServerRequestSchema,
  SwitchServerRequestSchema,
} from './orgs.openapi.js';
import type { z } from '../openapi/registry.js';

function isServerRequest(req: Request): boolean {
  // Router() matches case-insensitively and accepts a trailing slash by default.
  // Normalize only this discriminator; preserve the original request and IDs.
  const pathname = req.path.toLowerCase().replace(/\/$/, '');
  return (
    pathname === '/api/server/switch' ||
    pathname === '/api/servers' ||
    pathname.startsWith('/api/servers/')
  );
}

function connectionNoun(req: Request): string {
  return isServerRequest(req) ? 'server' : 'org';
}

function connectionResponse(
  req: Request,
  org: OrgRow,
): OrgRow | ReturnType<typeof toServerConnection> {
  return isServerRequest(req) ? toServerConnection(org) : org;
}

function connectionId(req: Request, id: string): { serverId: string } | { orgId: string } {
  return isServerRequest(req) ? { serverId: id } : { orgId: id };
}

// Validate the new contract without tightening historical /api/orgs inputs.
function validateServerBody(schema: z.ZodType) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!isServerRequest(req)) return next();
    const result = schema.safeParse(req.body);
    if (!result.success) return res.status(400).json({ error: result.error.message });
    req.body = result.data;
    next();
  };
}

/**
 * True when neither mechanism (JWT-backed user store nor apiKey) is
 * configured. In that mode the auth middleware is a passthrough, so no
 * route should try to gate by membership — every caller is anonymous.
 */
function authIsConfigured(): boolean {
  return Boolean(getAuthRecord()) || Boolean(config.apiKey);
}

export default function createOrgRoutes(deps: RouteDeps): Router {
  const {
    initDb,
    broadcast,
    allAgents,
    reloadProjects,
    getProjects,
    autonomousCrons,
    restoreAutonomousCrons,
    setActiveDataDir,
    scheduleAll,
    // Required RouteDeps members (see server/types.ts `RouteDeps`). Both are
    // consumed by performOrgSwitch below; the production object is wired in
    // server/index.ts `routeDeps`. test/orgs-switch.test.ts pins the wiring.
    ensureSkillBuilderAgents,
    ensureQaAgents,
  } = deps;
  const router = Router();

  function performOrgSwitch(orgId: string): void {
    // The SPA posts /orgs/:id/switch on every App mount (and React Strict
    // Mode doubles it). Re-running initDb + scheduleAll for the org we
    // are already on floods the log, flaps WebSockets, and can wedge the
    // event loop under a reload storm. No-op when already active.
    if (getActiveOrgId() === orgId) {
      return;
    }

    const dataDir = orgDataDir(orgId);
    mkdirSync(dataDir, { recursive: true });

    console.log(`[Org] Switching to org ${orgId} → ${dataDir}`);

    initDb(dataDir);
    setActiveDataDir(dataDir);
    setActiveOrgId(orgId);

    reloadProjects(dataDir);
    repairOrganizationWorkspaces(orgId);
    // First time this org becomes active, backfill the per-project Skill
    // Builder coach into any pre-feature projects (marker-guarded, once).
    // Best-effort: a seeding/marker-write hiccup must never break the org
    // switch itself (the UI switches to the active org on every connect),
    // so swallow-and-log. An unwritten marker just means a retry next time.
    try {
      backfillSkillBuilderAgents({
        dataDir,
        ensureSkillBuilderAgents: () => ensureSkillBuilderAgents(),
      });
    } catch (err) {
      console.warn(
        `[Skill Builder] backfill skipped for org switch (${orgId}):`,
        err instanceof Error ? err.message : String(err),
      );
    }
    // Same once-per-org guard for the per-project QA agent.
    try {
      backfillQaAgents({ dataDir, ensureQaAgents: () => ensureQaAgents() });
    } catch (err) {
      console.warn(
        `[QA Agent] backfill skipped for org switch (${orgId}):`,
        err instanceof Error ? err.message : String(err),
      );
    }
    scheduleAll(allAgents());

    for (const [_key, task] of autonomousCrons) {
      (task as { stop: () => void }).stop();
    }
    autonomousCrons.clear();
    restoreAutonomousCrons();

    broadcast({ type: 'org_switched', orgId, dataDir });
  }

  router.get(['/api/orgs', '/api/servers'], (_req: Request, res: Response) => {
    res.json(getAllOrgs().map((org) => connectionResponse(_req, org)));
  });

  router.get(['/api/orgs/:id', '/api/servers/:id'], (req: Request, res: Response) => {
    const org = getOrg(req.params.id as string);
    if (!org)
      return res
        .status(404)
        .json({ error: isServerRequest(req) ? 'Server not found' : 'Org not found' });
    res.json(connectionResponse(req, org));
  });

  // GET /api/orgs/:id/members — Admin+ of that org. Lists members + roles.
  router.get(
    ['/api/orgs/:id/members', '/api/servers/:id/members'],
    (req: Request, res: Response) => {
      const authedReq = req as AuthenticatedRequest;
      const { id: orgId } = req.params as { id: string };
      const org = getOrg(orgId);
      if (!org)
        return res
          .status(404)
          .json({ error: isServerRequest(req) ? 'Server not found' : 'Org not found' });

      // apiKey callers are global Owner; JWT callers must be Admin+ of the
      // org being listed (not just the currently-active org). In the
      // no-auth-configured dev mode, allow through.
      if (authIsConfigured() && !authedReq.authViaApiKey && !authedReq.authLocalOrgBypass) {
        if (!authedReq.authUserId) {
          return res.status(401).json({ error: 'Authentication required.' });
        }
        const callerRole = getMembershipRole(authedReq.authUserId, orgId);
        if (!callerRole || (callerRole !== 'Owner' && callerRole !== 'Admin')) {
          return res.status(403).json({
            error: `Admin or Owner of this ${connectionNoun(req)} required.`,
          });
        }
      }

      const members = listMembersForOrg(orgId);
      return res.json({
        ...connectionId(req, orgId),
        members: members.map((m) => ({
          id: m.userId,
          username: m.username,
          role: m.role,
          createdAt: m.createdAt,
        })),
      });
    },
  );

  router.post(
    ['/api/orgs', '/api/servers'],
    validateServerBody(CreateServerRequestSchema),
    (req: Request, res: Response) => {
      const authedReq = req as AuthenticatedRequest;
      const { id, name, mode, color, remoteUrl, apiKey } = req.body as {
        id?: string;
        name?: string;
        mode?: string;
        color?: string;
        remoteUrl?: string;
        apiKey?: string;
      };
      if (!name) return res.status(400).json({ error: 'name is required' });

      // Require Owner of the caller's active org. apiKey callers bypass
      // (they already hold full-server privilege). No-auth dev mode also
      // bypasses so the UI-less boot path keeps working.
      if (authIsConfigured() && !authedReq.authViaApiKey) {
        if (authedReq.authRole !== 'Owner') {
          return res
            .status(403)
            .json({ error: `Only an Owner can create a new ${connectionNoun(req)}.` });
        }
      }

      const org = createOrgRecord({ id, name, mode, color, remoteUrl, apiKey });
      // Seed an Owner membership for the creator so they can immediately
      // switch into the new org. apiKey callers won't have a user id, so
      // we leave the new org ownerless — they'll invite members via the
      // regular flow.
      if (org && authedReq.authUserId) {
        try {
          createMembership(authedReq.authUserId, org.id, 'Owner');
        } catch (err) {
          console.warn('[Org] Failed to seed Owner membership for creator:', err);
        }
      }
      return res.status(201).json(org ? connectionResponse(req, org) : org);
    },
  );

  router.put(
    ['/api/orgs/:id', '/api/servers/:id'],
    validateServerBody(UpdateServerRequestSchema),
    (req: Request, res: Response) => {
      const { name, mode, color, remoteUrl, apiKey, position } = req.body as {
        name?: string;
        mode?: string;
        color?: string;
        remoteUrl?: string;
        apiKey?: string;
        position?: number;
      };
      const org = updateOrgRecord(req.params.id as string, {
        name,
        mode,
        color,
        remoteUrl,
        apiKey,
        position,
      });
      if (!org)
        return res
          .status(404)
          .json({ error: isServerRequest(req) ? 'Server not found' : 'Org not found' });
      res.json(connectionResponse(req, org));
    },
  );

  router.delete(['/api/orgs/:id', '/api/servers/:id'], (req: Request, res: Response) => {
    const authedReq = req as AuthenticatedRequest;
    const { id: orgId } = req.params as { id: string };
    const existing = getOrg(orgId);
    if (!existing)
      return res
        .status(404)
        .json({ error: isServerRequest(req) ? 'Server not found' : 'Org not found' });

    if (authIsConfigured() && !authedReq.authViaApiKey && !authedReq.authLocalOrgBypass) {
      if (!authedReq.authUserId) {
        return res.status(401).json({ error: 'Authentication required.' });
      }
      const role = getMembershipRole(authedReq.authUserId, orgId);
      if (role !== 'Owner') {
        return res
          .status(403)
          .json({ error: `Only an Owner of this ${connectionNoun(req)} can delete it.` });
      }
    }

    const ok = deleteOrgRecord(orgId);
    if (!ok)
      return res.status(400).json({ error: `Cannot delete the last ${connectionNoun(req)}` });
    return res.json({ ok: true });
  });

  function gateOrgSwitch(authedReq: AuthenticatedRequest, orgId: string): string | null {
    // When the server is running without any auth configured (fresh
    // install / dev), the middleware is a passthrough — don't gate here
    // either. Once auth is configured, `authUserId` or `authViaApiKey`
    // will be set by the middleware and we fall back to the gate.
    if (!authIsConfigured()) return null;
    if (authedReq.authViaApiKey) return null;
    if (authedReq.authLocalOrgBypass) return null;
    if (!authedReq.authUserId) return 'Authentication required.';
    const role = getMembershipRole(authedReq.authUserId, orgId);
    if (!role) return `You are not a member of this ${connectionNoun(authedReq)}.`;
    return null;
  }

  router.post(
    ['/api/orgs/:id/switch', '/api/servers/:id/switch'],
    (req: Request, res: Response) => {
      const org = getOrg(req.params.id as string);
      if (!org)
        return res
          .status(404)
          .json({ error: isServerRequest(req) ? 'Server not found' : 'Org not found' });

      const authedReq = req as AuthenticatedRequest;
      const blocked = gateOrgSwitch(authedReq, org.id);
      if (blocked) return res.status(403).json({ error: blocked });

      try {
        performOrgSwitch(org.id);
        return res.json({
          ok: true,
          ...connectionId(req, org.id),
          projects: getProjects().length,
          agents: allAgents().length,
        });
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        console.error('[Org] Switch failed:', message);
        return res
          .status(500)
          .json({ error: `Failed to switch ${connectionNoun(req)}: ${message}` });
      }
    },
  );

  router.post(
    ['/api/org/switch', '/api/server/switch'],
    validateServerBody(SwitchServerRequestSchema),
    (req: Request, res: Response) => {
      const orgId = (isServerRequest(req) ? req.body.serverId : req.body.orgId) as
        | string
        | undefined;
      if (!orgId)
        return res
          .status(400)
          .json({ error: `${isServerRequest(req) ? 'serverId' : 'orgId'} is required` });

      if (isServerRequest(req) && !getOrg(orgId)) {
        return res.status(404).json({ error: 'Server not found' });
      }

      const authedReq = req as AuthenticatedRequest;
      const blocked = gateOrgSwitch(authedReq, orgId);
      if (blocked) return res.status(403).json({ error: blocked });

      try {
        performOrgSwitch(orgId);
        return res.json({
          ok: true,
          ...connectionId(req, orgId),
          projects: getProjects().length,
          agents: allAgents().length,
        });
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        console.error('[Org] Switch failed:', message);
        return res
          .status(500)
          .json({ error: `Failed to switch ${connectionNoun(req)}: ${message}` });
      }
    },
  );

  return router;
}
