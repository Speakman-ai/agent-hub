/**
 * /api/me/browser-profiles — the caller's saved browser sign-ins. Every
 * lookup is keyed on `req.authUserId`; there is deliberately no admin route,
 * so Owners and Admins cannot read another user's profiles. Responses carry
 * domains and counts only, never cookie names or values.
 */
import { Router, type Request, type Response } from 'express';
import type { AuthenticatedRequest } from '../auth.js';
import {
  BrowserProfileDecryptError,
  clearBrowserProfileDomain,
  deleteBrowserProfile,
  getBrowserProfileForUser,
  isBrowserProfileInUse,
  listBrowserProfilesForUser,
  summarizeBrowserProfileDomains,
  type BrowserProfile,
} from '../browser-profiles-store.js';
import type { RouteDeps } from '../types.js';
import {
  deleteBrowserDomainPolicy,
  isBrowserDomainPolicy,
  listBrowserDomainPolicies,
  setBrowserDomainPolicy,
} from '../browser-domain-policy.js';
import { isAgentCaller } from './approvals.js';

const UNREADABLE =
  'Saved browser state for this profile cannot be decrypted. Delete the profile to start fresh.';

export default function createMeBrowserProfilesRoutes(deps: RouteDeps): Router {
  const router = Router();

  function serialize(p: BrowserProfile) {
    let agentName = p.agentId;
    let projectName = p.projectId;
    try {
      const found = deps.findAgent?.(p.agentId);
      if (found?.agent?.name) agentName = found.agent.name;
      const project = deps.findProject?.(p.projectId);
      if (project?.name) projectName = project.name;
    } catch {
      // Names are cosmetic; fall back to ids.
    }
    return {
      id: p.id,
      agentId: p.agentId,
      agentName,
      projectId: p.projectId,
      projectName,
      domains: p.domains,
      domainPolicies: listBrowserDomainPolicies(p.id).map(({ domain, policy }) => ({
        domain,
        policy,
      })),
      hasState: p.hasState,
      inUse: isBrowserProfileInUse(p),
      lastUsedAt: p.lastSavedAt,
      createdAt: p.createdAt,
      updatedAt: p.updatedAt,
    };
  }

  function caller(req: Request, res: Response): string | null {
    const userId = (req as AuthenticatedRequest).authUserId;
    if (!userId) {
      res.status(401).json({ error: 'Authentication required' });
      return null;
    }
    return userId;
  }

  function ownedProfile(req: Request, res: Response): BrowserProfile | null {
    const userId = caller(req, res);
    if (!userId) return null;
    const profile = getBrowserProfileForUser(userId, String(req.params.profileId ?? ''));
    if (!profile) {
      res.status(404).json({ error: 'Browser profile not found' });
      return null;
    }
    return profile;
  }

  router.get('/api/me/browser-profiles', (req: Request, res: Response) => {
    const userId = caller(req, res);
    if (!userId) return;
    res.json({ profiles: listBrowserProfilesForUser(userId).map(serialize) });
  });

  router.get('/api/me/browser-profiles/:profileId/domains', (req: Request, res: Response) => {
    const profile = ownedProfile(req, res);
    if (!profile) return;
    try {
      res.json({ profileId: profile.id, domains: summarizeBrowserProfileDomains(profile) });
    } catch (err) {
      if (err instanceof BrowserProfileDecryptError) {
        return res.status(409).json({ error: UNREADABLE });
      }
      throw err;
    }
  });

  router.delete(
    '/api/me/browser-profiles/:profileId/domains/:domain',
    (req: Request, res: Response) => {
      const profile = ownedProfile(req, res);
      if (!profile) return;
      if (isBrowserProfileInUse(profile)) {
        return res.status(409).json({
          error:
            'A running session is using this profile. Close its browser, then clear the domain.',
        });
      }
      try {
        const updated = clearBrowserProfileDomain(profile, String(req.params.domain ?? ''));
        if (!updated) return res.status(404).json({ error: 'Domain not saved in this profile' });
        res.json(serialize(updated));
      } catch (err) {
        if (err instanceof BrowserProfileDecryptError) {
          return res.status(409).json({ error: UNREADABLE });
        }
        throw err;
      }
    },
  );

  /** Policy edits loosen or tighten the agent's own gate, so agents may not make them. */
  function policyEditor(req: Request, res: Response): BrowserProfile | null {
    if (isAgentCaller(req)) {
      res.status(403).json({
        error: 'Browser profile policies must be changed by a person, not an agent',
      });
      return null;
    }
    return ownedProfile(req, res);
  }

  router.put(
    '/api/me/browser-profiles/:profileId/domain-policies/:domain',
    (req: Request, res: Response) => {
      const profile = policyEditor(req, res);
      if (!profile) return;
      const policy = (req.body as { policy?: unknown } | undefined)?.policy;
      if (!isBrowserDomainPolicy(policy)) {
        return res.status(400).json({ error: 'policy must be allow, ask or block' });
      }
      if (!setBrowserDomainPolicy(profile.id, String(req.params.domain ?? ''), policy)) {
        return res.status(400).json({ error: 'domain must be a hostname such as example.com' });
      }
      res.json(serialize(profile));
    },
  );

  router.delete(
    '/api/me/browser-profiles/:profileId/domain-policies/:domain',
    (req: Request, res: Response) => {
      const profile = policyEditor(req, res);
      if (!profile) return;
      if (!deleteBrowserDomainPolicy(profile.id, String(req.params.domain ?? ''))) {
        return res.status(404).json({ error: 'No policy for this domain' });
      }
      res.json(serialize(profile));
    },
  );

  // Deleting a profile also drops its site policies and approval rules, so an
  // agent that could delete it would shed the human's gate along with it.
  router.delete('/api/me/browser-profiles/:profileId', (req: Request, res: Response) => {
    const profile = policyEditor(req, res);
    if (!profile) return;
    deleteBrowserProfile(profile);
    res.json({ ok: true });
  });

  return router;
}
