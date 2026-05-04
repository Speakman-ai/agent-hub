/**
 * Per-user integrations REST API.
 *
 * Routes:
 *   POST   /api/users/:userId/integrations/:app/connect   — start OAuth flow
 *   GET    /api/users/:userId/integrations                — list user connections
 *   GET    /api/users/:userId/integrations/:app           — single connection (poll-after-popup)
 *   DELETE /api/users/:userId/integrations/:app           — tear down connection
 *   POST   /api/integrations/webhooks/nango               — Nango webhook (public, sig-gated)
 *
 * Authorization model
 * -------------------
 * The user CRUD routes apply a "userId-or-Owner" gate:
 *   - The caller MUST either be authenticated as the userId in the path,
 *     OR carry an Owner role (full break-glass access).
 *   - Cross-user access intentionally returns **404 Not Found** (not 403)
 *     — refusing to confirm whether the target user even exists. Mirrors
 *     the per-user session ownership model in `server/sessions/`.
 *   - The local-bundled bypass (`authLocalOrgBypass`, set by Electron /
 *     dev mode) is treated as full Owner access.
 *
 * Webhook signature verification
 * ------------------------------
 * Nango POSTs an HMAC-SHA256 of the raw request body in the
 * `X-Nango-Hmac-Sha256` header (hex-encoded). We:
 *   1. Refuse the call if no `webhookSecret` is configured (fail-closed).
 *   2. Recompute `HMAC-SHA256(webhookSecret, rawBody)` and compare with
 *      `crypto.timingSafeEqual` to defeat timing oracles.
 *   3. Confirm the embedded `endUser.endUserId` carries our hub's
 *      `${hubInstanceId}:` prefix — refusing cross-tenant payloads even
 *      if the operator accidentally shares a webhook secret with another
 *      Hub install.
 *   4. On `type === 'auth' && operation === 'creation' && success`, flip
 *      the row from PENDING → CONNECTED.
 *
 * Status enum
 * -----------
 * The store's `UserIntegrationStatus` enum uses CONNECTED (not "ACTIVE")
 * for the post-OAuth steady state — see `server/user-integrations-store.ts`.
 * The kanban card description used the colloquial "ACTIVE"; we honour the
 * existing enum for consistency.
 *
 * Mocking
 * -------
 * The route factory accepts `getProvider` / `getWebhookSecret` /
 * `getHubInstanceId` overrides so route-level integration tests can run
 * without a real Nango key in CI.
 */

import { Router, type Request, type Response } from 'express';
import crypto from 'crypto';
import type { AuthenticatedRequest } from '../auth.js';
import type { RouteDeps } from '../types.js';
import {
  getIntegrationProvider,
  IntegrationProviderError,
  type IntegrationProvider,
} from '../integrations/provider.js';
import { getIntegrationProviderConfig } from '../integration-provider-runtime.js';
import { getHubInstanceId } from '../integrations/hub-instance.js';
import * as userIntegrationsStore from '../user-integrations-store.js';

export interface IntegrationsRoutesDeps {
  /** Test override — production resolves the singleton via getIntegrationProvider(). */
  getProvider?: () => IntegrationProvider;
  /** Test override — production reads the secret via integration-provider-runtime. */
  getWebhookSecret?: () => string;
  /** Test override — production reads via getHubInstanceId(). */
  getHubInstanceId?: () => string;
}

/**
 * Returns true iff the caller is allowed to read/write the integrations
 * row for `userId`. Owner role + the local-bundled bypass grant blanket
 * access; otherwise the authenticated user id MUST match the path id.
 */
function isAuthorizedForUser(req: Request, userId: string): boolean {
  const auth = req as AuthenticatedRequest;
  if (auth.authLocalOrgBypass) return true;
  if (auth.authRole === 'Owner') return true;
  if (auth.authUserId && auth.authUserId === userId) return true;
  return false;
}

interface NangoWebhookBody {
  type?: string;
  operation?: string;
  success?: boolean;
  connectionId?: string;
  providerConfigKey?: string;
  endUser?: { endUserId?: string } | null;
  endUserId?: string;
  end_user?: { id?: string } | null;
}

/**
 * Resolve the `endUserId` field across the historical Nango payload
 * shapes. The current docs (`endUser.endUserId`) and the legacy/v0
 * shapes (`endUserId`, `end_user.id`) are all accepted to stay
 * forward-compatible during the field migration.
 */
function extractEndUserId(body: NangoWebhookBody): string {
  return body.endUser?.endUserId ?? body.endUserId ?? body.end_user?.id ?? '';
}

export default function createIntegrationsRoutes(
  _routeDeps: RouteDeps,
  extra: IntegrationsRoutesDeps = {},
): Router {
  const router = Router();
  const resolveProvider = extra.getProvider ?? getIntegrationProvider;
  const resolveWebhookSecret =
    extra.getWebhookSecret ??
    (() => {
      try {
        const r = getIntegrationProviderConfig();
        return r.ok ? r.webhookSecret : '';
      } catch {
        return '';
      }
    });
  const resolveHubInstance = extra.getHubInstanceId ?? (() => getHubInstanceId());

  // ── POST /api/users/:userId/integrations/:app/connect ─────────────
  router.post(
    '/api/users/:userId/integrations/:app/connect',
    async (req: Request, res: Response) => {
      const userId = req.params.userId as string;
      const app = req.params.app as string;
      if (!isAuthorizedForUser(req, userId)) {
        return res.status(404).json({ error: 'Not found' });
      }
      let provider: IntegrationProvider;
      try {
        provider = resolveProvider();
      } catch (err) {
        if (err instanceof IntegrationProviderError) {
          return res.status(503).json({ error: err.message });
        }
        return res.status(503).json({ error: (err as Error).message });
      }
      try {
        const hubInstanceId = resolveHubInstance();
        const result = await provider.createConnection({ hubInstanceId, userId, app });
        // Idempotent upsert — a second POST for the same (user, app)
        // overwrites the prior PENDING row with the new session token,
        // which is the desired behaviour when a user re-clicks "Connect"
        // before completing the first attempt.
        userIntegrationsStore.upsert({
          userId,
          app,
          connectionId: result.connectionId,
          status: 'PENDING',
          metadata: { endUserId: result.endUserId },
        });
        return res.status(201).json({ authUrl: result.authUrl, connectionId: result.connectionId });
      } catch (err) {
        if (err instanceof IntegrationProviderError) {
          // Pass through 4xx from upstream; clamp 5xx to 502 so a Nango
          // outage doesn't masquerade as our own server error.
          const status = err.status >= 400 && err.status < 500 ? err.status : 502;
          return res.status(status).json({ error: err.message });
        }
        return res.status(500).json({ error: (err as Error).message });
      }
    },
  );

  // ── GET /api/users/:userId/integrations ───────────────────────────
  router.get('/api/users/:userId/integrations', (req: Request, res: Response) => {
    const userId = req.params.userId as string;
    if (!isAuthorizedForUser(req, userId)) {
      return res.status(404).json({ error: 'Not found' });
    }
    const rows = userIntegrationsStore.listForUser(userId);
    return res.json({ integrations: rows });
  });

  // ── GET /api/users/:userId/integrations/:app ──────────────────────
  router.get('/api/users/:userId/integrations/:app', (req: Request, res: Response) => {
    const userId = req.params.userId as string;
    const app = req.params.app as string;
    if (!isAuthorizedForUser(req, userId)) {
      return res.status(404).json({ error: 'Not found' });
    }
    const row = userIntegrationsStore.getForUser(userId, app);
    if (!row) {
      return res.status(404).json({ error: 'Not found' });
    }
    return res.json(row);
  });

  // ── DELETE /api/users/:userId/integrations/:app ───────────────────
  router.delete('/api/users/:userId/integrations/:app', async (req: Request, res: Response) => {
    const userId = req.params.userId as string;
    const app = req.params.app as string;
    if (!isAuthorizedForUser(req, userId)) {
      return res.status(404).json({ error: 'Not found' });
    }
    const row = userIntegrationsStore.getForUser(userId, app);
    if (!row) {
      return res.status(404).json({ error: 'Not found' });
    }
    try {
      const provider = resolveProvider();
      await provider.deleteConnection(row.connectionId);
    } catch (err) {
      // Provider 404 is idempotent success (already torn down upstream)
      // — fall through to local row delete. Anything else surfaces as
      // 502 and we KEEP the local row so the user can retry.
      if (err instanceof IntegrationProviderError) {
        if (err.status !== 404) {
          return res.status(502).json({ error: err.message });
        }
      } else {
        return res.status(502).json({ error: (err as Error).message });
      }
    }
    userIntegrationsStore.delete(userId, app);
    return res.status(204).end();
  });

  // ── POST /api/integrations/webhooks/nango ─────────────────────────
  // Public route — the HMAC signature IS the auth. Must be added to
  // PUBLIC_PATHS in server/auth.ts so the global gate lets it through.
  router.post('/api/integrations/webhooks/nango', (req: Request, res: Response) => {
    const secret = resolveWebhookSecret();
    if (!secret) {
      // Fail-closed: a deploy that forgets to configure the webhook
      // secret should not silently accept unsigned payloads.
      return res.status(404).json({ error: 'Webhook not configured' });
    }
    const headerSig = req.headers['x-nango-hmac-sha256'];
    const sig = Array.isArray(headerSig) ? headerSig[0] : headerSig;
    const rawBody = (req as Request & { rawBody?: Buffer }).rawBody;
    if (!sig || typeof sig !== 'string' || !rawBody) {
      return res.status(401).json({ error: 'Missing signature' });
    }

    const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
    let valid = false;
    try {
      const a = Buffer.from(sig, 'hex');
      const b = Buffer.from(expected, 'hex');
      valid = a.length === b.length && crypto.timingSafeEqual(a, b);
    } catch {
      valid = false;
    }
    if (!valid) {
      return res.status(401).json({ error: 'Invalid signature' });
    }

    let body: NangoWebhookBody;
    try {
      body = JSON.parse(rawBody.toString('utf8')) as NangoWebhookBody;
    } catch {
      return res.status(400).json({ error: 'Malformed JSON' });
    }

    const type = body.type;
    const operation = body.operation;
    const success = body.success !== false; // default to true if omitted

    // Acknowledge but ignore non-auth-creation events. Sync runs and
    // refresh-token failures travel through the same endpoint; we don't
    // want to 4xx them or Nango will retry forever.
    if (type !== 'auth' || operation !== 'creation' || !success) {
      return res.status(200).json({ ok: true, ignored: true });
    }

    const connectionId = body.connectionId;
    const providerConfigKey = body.providerConfigKey;
    const endUserId = extractEndUserId(body);
    if (!connectionId || !providerConfigKey || !endUserId) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    // Tenant-prefix gate: refuse payloads that don't carry our hub's
    // instance prefix. Prevents another Hub install (sharing a Nango
    // project) from accidentally racing-in CONNECTED rows on our table.
    const hubInstanceId = resolveHubInstance();
    const expectedPrefix = `${hubInstanceId}:`;
    if (!endUserId.startsWith(expectedPrefix)) {
      // 200 (acknowledge) so Nango doesn't retry a payload that's
      // legitimately not ours — but log nothing to the table.
      return res.status(200).json({ ok: true, ignored: 'cross-tenant' });
    }
    const userId = endUserId.slice(expectedPrefix.length);
    if (!userId) {
      return res.status(400).json({ error: 'Empty user id' });
    }

    userIntegrationsStore.upsert({
      userId,
      app: providerConfigKey,
      connectionId,
      status: 'CONNECTED',
      metadata: { endUserId },
    });

    return res.json({ ok: true });
  });

  return router;
}
