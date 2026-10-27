/**
 * GET /api/google/accounts — the Google accounts the caller can act as through
 * the `/api/google/*` proxies, default first. Resolves the caller the same way
 * the proxies do, so an agent on the break-glass key with a session id sees the
 * SESSION OWNER's accounts. Never returns tokens.
 */
import { Router, Request, Response } from 'express';
import type { RouteDeps } from '../types.js';
import { listGoogleConnections } from '../google-connections-store.js';
import { resolveGoogleConnectionUserId } from '../google-connection-user.js';
import { registerPath, z } from '../openapi/registry.js';

const LinkedGoogleAccountSchema = z
  .object({
    accountId: z.string(),
    email: z.string(),
    isDefault: z.boolean(),
    grantedScopes: z.array(z.string()),
    connectedAt: z.string(),
  })
  .openapi('LinkedGoogleAccount');

const GoogleAccountsResponseSchema = z.object({
  defaultAccountId: z.string().nullable(),
  accounts: z.array(LinkedGoogleAccountSchema),
});

registerPath({
  method: 'get',
  path: '/api/google/accounts',
  tags: ['Google'],
  summary: 'List the Google accounts the caller can act as through the Google proxies',
  description:
    'Default account first. Pass an `accountId` or `email` from this list as the `account` query parameter on `/api/google/{calendar,gmail,sheets,drive}/*` to act as that account; omit it to use the default.',
  responses: {
    200: {
      description: 'Linked accounts (empty when none are linked).',
      content: { 'application/json': { schema: GoogleAccountsResponseSchema } },
    },
    401: {
      description: 'Not authenticated.',
      content: {
        'application/json': { schema: z.object({ error: z.string(), code: z.string() }) },
      },
    },
  },
});

export default function createGoogleAccountsRoutes(deps: RouteDeps): Router {
  const router = Router();

  router.get('/api/google/accounts', (req: Request, res: Response) => {
    const uid = resolveGoogleConnectionUserId(req, deps.stmts);
    if (!uid) {
      return res
        .status(401)
        .json({ error: 'Authentication required', code: 'authentication_required' });
    }
    const accounts = listGoogleConnections(uid).map((c) => ({
      accountId: c.accountId,
      email: c.googleEmail,
      isDefault: c.isDefault,
      grantedScopes: c.grantedScopes,
      connectedAt: c.connectedAt,
    }));
    return res.json({
      defaultAccountId: accounts.find((a) => a.isDefault)?.accountId ?? null,
      accounts,
    });
  });

  return router;
}
