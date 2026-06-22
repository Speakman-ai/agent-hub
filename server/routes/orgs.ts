import { Router, Request, Response } from 'express';
import { mkdirSync } from 'fs';
import {
  getAllOrgs,
  getOrg,
  createOrg as createOrgRecord,
  updateOrg as updateOrgRecord,
  deleteOrg as deleteOrgRecord,
  orgDataDir,
  setActiveOrgId,
} from '../orgs.js';
import { createMembership, getMembershipRole, listMembersForOrg } from '../memberships-store.js';
import type { AuthenticatedRequest } from '../auth.js';
import { getAuthRecord } from '../auth-store.js';
import config from '../config.js';
import { backfillSkillBuilderAgents } from '../migrations/backfill-skill-builder-agents.js';
import type { RouteDeps } from '../types.js';

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
  } = deps;
  const router = Router();

  function performOrgSwitch(orgId: string): void {
    const dataDir = orgDataDir(orgId);
    mkdirSync(dataDir, { recursive: true });

    console.log(`[Org] Switching to org ${orgId} → ${dataDir}`);

    initDb(dataDir);
    setActiveDataDir(dataDir);
    setActiveOrgId(orgId);

    reloadProjects(dataDir);
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
    scheduleAll(allAgents());

    for (const [_key, task] of autonomousCrons) {
      (task as { stop: () => void }).stop();
    }
    autonomousCrons.clear();
    restoreAutonomousCrons();

    broadcast({ type: 'org_switched', orgId, dataDir });
  }

  router.get('/api/orgs', (_req: Request, res: Response) => {
    res.json(getAllOrgs());
  });

  router.get('/api/orgs/:id', (req: Request, res: Response) => {
    const org = getOrg(req.params.id as string);
    if (!org) return res.status(404).json({ error: 'Org not found' });
    res.json(org);
  });

  // GET /api/orgs/:id/members — Admin+ of that org. Lists members + roles.
  router.get('/api/orgs/:id/members', (req: Request, res: Response) => {
    const authedReq = req as AuthenticatedRequest;
    const { id: orgId } = req.params as { id: string };
    const org = getOrg(orgId);
    if (!org) return res.status(404).json({ error: 'Org not found' });

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
          error: 'Admin or Owner of this org required.',
        });
      }
    }

    const members = listMembersForOrg(orgId);
    return res.json({
      orgId,
      members: members.map((m) => ({
        id: m.userId,
        username: m.username,
        role: m.role,
        createdAt: m.createdAt,
      })),
    });
  });

  router.post('/api/orgs', (req: Request, res: Response) => {
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
        return res.status(403).json({ error: 'Only an Owner can create a new org.' });
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
    return res.status(201).json(org);
  });

  router.put('/api/orgs/:id', (req: Request, res: Response) => {
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
    if (!org) return res.status(404).json({ error: 'Org not found' });
    res.json(org);
  });

  router.delete('/api/orgs/:id', (req: Request, res: Response) => {
    const authedReq = req as AuthenticatedRequest;
    const { id: orgId } = req.params as { id: string };
    const existing = getOrg(orgId);
    if (!existing) return res.status(404).json({ error: 'Org not found' });

    if (authIsConfigured() && !authedReq.authViaApiKey && !authedReq.authLocalOrgBypass) {
      if (!authedReq.authUserId) {
        return res.status(401).json({ error: 'Authentication required.' });
      }
      const role = getMembershipRole(authedReq.authUserId, orgId);
      if (role !== 'Owner') {
        return res.status(403).json({ error: 'Only an Owner of this org can delete it.' });
      }
    }

    const ok = deleteOrgRecord(orgId);
    if (!ok) return res.status(400).json({ error: 'Cannot delete the last org' });
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
    if (!role) return 'You are not a member of this org.';
    return null;
  }

  router.post('/api/orgs/:id/switch', (req: Request, res: Response) => {
    const org = getOrg(req.params.id as string);
    if (!org) return res.status(404).json({ error: 'Org not found' });

    const authedReq = req as AuthenticatedRequest;
    const blocked = gateOrgSwitch(authedReq, org.id);
    if (blocked) return res.status(403).json({ error: blocked });

    try {
      performOrgSwitch(org.id);
      return res.json({
        ok: true,
        orgId: org.id,
        projects: getProjects().length,
        agents: allAgents().length,
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error('[Org] Switch failed:', message);
      return res.status(500).json({ error: `Failed to switch org: ${message}` });
    }
  });

  router.post('/api/org/switch', (req: Request, res: Response) => {
    const { orgId } = req.body as { orgId?: string };
    if (!orgId) return res.status(400).json({ error: 'orgId is required' });

    const authedReq = req as AuthenticatedRequest;
    const blocked = gateOrgSwitch(authedReq, orgId);
    if (blocked) return res.status(403).json({ error: blocked });

    try {
      performOrgSwitch(orgId);
      return res.json({
        ok: true,
        orgId,
        projects: getProjects().length,
        agents: allAgents().length,
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error('[Org] Switch failed:', message);
      return res.status(500).json({ error: `Failed to switch org: ${message}` });
    }
  });

  return router;
}
