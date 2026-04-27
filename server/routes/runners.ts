/**
 * Runner registry routes (Phase 1 of the control-plane / runner split).
 *
 *   POST   /api/runners            — register a new runner; returns plaintext token (once)
 *   GET    /api/runners            — list runners in the active org
 *   GET    /api/runners/:id        — fetch one runner (no token)
 *   DELETE /api/runners/:id        — revoke a runner (deletes row + invalidates token)
 *
 * Auth: gated by the standard `authMiddleware` chain mounted on the
 * Express app. In the no-auth-configured dev mode, every caller is
 * effectively anonymous, which is fine for local development. In
 * production a JWT or apiKey caller is required because the middleware
 * rejects unauthenticated requests.
 *
 * Cross-org authorization: every route resolves the target org and gates
 * the caller's membership via `requireOrgMembership`. POST and DELETE
 * require Admin+ (minting/revoking spawn credentials is an elevated
 * action); GET requires any membership.
 *
 * The plaintext token is never persisted — only `sha256(token)` lives in
 * the row. Callers must capture the response from `POST /api/runners`
 * and stash it on the runner machine; if lost, the runner has to be
 * re-registered.
 */
import { Router, Request, Response } from 'express';
import { createRunner, deleteRunner, getRunner, listRunners } from '../runners-store.js';
import { getActiveOrgId } from '../orgs.js';
import { getMembershipRole } from '../memberships-store.js';
import { getAuthRecord } from '../auth-store.js';
import { hasAtLeastRole } from '../roles.js';
import config from '../config.js';
import type { AuthenticatedRequest } from '../auth.js';
import type { RouteDeps } from '../types.js';

/** True when JWT or apiKey auth is configured. Mirrors dashboard.ts / orgs.ts. */
function authIsConfigured(): boolean {
  return Boolean(getAuthRecord()) || Boolean(config.apiKey);
}

/**
 * Verify the caller has membership in `orgId`. Bypassed when auth isn't
 * configured, when the caller used the apiKey fallback, or when the
 * active org is local (single-tenant dev mode). Returns the caller's
 * role on success, or sends a 401/403 and returns null.
 */
function requireOrgMembership(
  req: Request,
  res: Response,
  orgId: string,
  minRole: 'Owner' | 'Admin' | 'User' = 'User',
): string | null {
  if (!authIsConfigured()) return 'Owner'; // no-auth dev mode
  const authedReq = req as AuthenticatedRequest;
  if (authedReq.authViaApiKey) return 'Owner'; // apiKey = break-glass Owner
  if (authedReq.authLocalOrgBypass) return 'Owner'; // local-org bypass
  if (!authedReq.authUserId) {
    res.status(401).json({ error: 'Authentication required.' });
    return null;
  }
  const role = getMembershipRole(authedReq.authUserId, orgId);
  if (!role) {
    res.status(403).json({ error: 'You are not a member of this org.' });
    return null;
  }
  if (!hasAtLeastRole(role, minRole)) {
    res.status(403).json({
      error: `This action requires the ${minRole} role or higher.`,
      requiredRole: minRole,
      currentRole: role,
    });
    return null;
  }
  return role;
}

export default function createRunnerRoutes(_deps: RouteDeps): Router {
  const router = Router();

  router.get('/api/runners', (req: Request, res: Response) => {
    const orgId = (req.query.orgId as string | undefined) ?? getActiveOrgId();
    if (!requireOrgMembership(req, res, orgId)) return;
    res.json({ runners: listRunners(orgId) });
  });

  router.get('/api/runners/:id', (req: Request, res: Response) => {
    const id = req.params.id as string;
    const runner = getRunner(id);
    if (!runner) return res.status(404).json({ error: 'Runner not found' });
    // Gate by the runner's owning org, not caller-supplied input.
    if (!requireOrgMembership(req, res, runner.orgId)) return;
    res.json(runner);
  });

  // Registering a runner is an elevated action — require Admin or above.
  router.post('/api/runners', (req: Request, res: Response) => {
    const body = (req.body ?? {}) as {
      name?: unknown;
      orgId?: unknown;
      capabilities?: unknown;
    };

    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!name) {
      return res.status(400).json({ error: 'name is required' });
    }
    if (name.length > 128) {
      return res.status(400).json({ error: 'name must be 128 chars or fewer' });
    }

    const orgId =
      typeof body.orgId === 'string' && body.orgId.trim() ? body.orgId.trim() : getActiveOrgId();

    // Org membership gate — minting spawn-capable tokens requires Admin+.
    if (!requireOrgMembership(req, res, orgId, 'Admin')) return;

    const capabilities =
      body.capabilities &&
      typeof body.capabilities === 'object' &&
      !Array.isArray(body.capabilities)
        ? (body.capabilities as Record<string, unknown>)
        : undefined;

    try {
      const { runner, token } = createRunner({ orgId, name, capabilities });
      // 201 Created. Token is returned exactly once — clients must save it.
      res.status(201).json({ runner, token });
    } catch (err) {
      const msg = (err as Error).message ?? 'failed to create runner';
      // SQLite UNIQUE constraint on (org_id, name) → 409 Conflict.
      if (/UNIQUE/i.test(msg)) {
        return res
          .status(409)
          .json({ error: `Runner with name "${name}" already exists in this org` });
      }
      res.status(500).json({ error: msg });
    }
  });

  // Revoking a runner requires Admin+ in the runner's owning org.
  router.delete('/api/runners/:id', (req: Request, res: Response) => {
    const id = req.params.id as string;
    const runner = getRunner(id);
    if (!runner) return res.status(404).json({ error: 'Runner not found' });
    if (!requireOrgMembership(req, res, runner.orgId, 'Admin')) return;
    deleteRunner(id);
    res.status(204).end();
  });

  return router;
}
