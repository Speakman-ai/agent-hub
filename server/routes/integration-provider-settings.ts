/**
 * Integration-provider Settings API.
 *
 * Backs Settings → Admin → Integrations. Owner-only — non-Owners hit
 * `requireRole('Owner')` and get a 403 with `requiredRole: 'Owner'`.
 *
 *   GET  /api/admin/integrations/provider           — masked read
 *   PUT  /api/admin/integrations/provider           — write (partial-preserving)
 *   POST /api/admin/integrations/provider/validate  — call Nango GET /environment
 *
 * Validate is intentionally side-effect-free: it issues one call to
 * `<baseUrl>/environment` with the candidate secret as a Bearer token
 * and returns either `{ ok: true, environment: { … } }` or
 * `{ ok: false, status, message }`. In **shared** mode the validate
 * route short-circuits with `ok: true` because the env var is
 * implicitly trusted — we don't have permission to call Nango with a
 * key the operator pasted into the build pipeline.
 */

import { Router, Request, Response } from 'express';
import type Database from 'better-sqlite3';
import {
  readIntegrationProviderMasked,
  readIntegrationProviderRow,
  writeIntegrationProviderConfig,
  MASK,
  type IntegrationProviderWrite,
  type IntegrationProviderMode,
  type IntegrationProviderId,
} from '../integration-provider-store.js';
import type { AuthenticatedRequest } from '../auth.js';
import { requireRole } from '../roles.js';
import type { RouteDeps } from '../types.js';

interface ValidateResult {
  ok: boolean;
  status?: number;
  message?: string;
  environment?: { name?: string; uniqueKey?: string };
}

interface ValidateAdapters {
  /** Hits `<baseUrl>/environment` with the candidate Bearer token. */
  validateNangoKey?: (secretKey: string, baseUrl: string) => Promise<ValidateResult>;
}

const DEFAULT_NANGO_BASE_URL = 'https://api.nango.dev';

/**
 * Default Nango key validator — calls the documented
 * `GET /environment` endpoint and treats any 2xx as success. The
 * endpoint shape changed in late-2024; we don't depend on the body
 * structure, only the status code, so a future Nango payload change
 * won't break this check.
 *
 *   docs: https://docs.nango.dev/reference/api/environment/get
 */
async function defaultValidateNangoKey(
  secretKey: string,
  baseUrl: string,
): Promise<ValidateResult> {
  if (!secretKey) {
    return { ok: false, status: 400, message: 'No Nango secret key configured.' };
  }
  const url = `${baseUrl.replace(/\/$/, '')}/environment`;
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${secretKey}`,
        Accept: 'application/json',
      },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      return {
        ok: false,
        status: res.status,
        message: `Nango ${res.status}: ${body.slice(0, 200) || 'no body'}`,
      };
    }
    let environment: ValidateResult['environment'] | undefined;
    try {
      const body = (await res.json()) as { name?: string; unique_key?: string };
      environment = { name: body?.name, uniqueKey: body?.unique_key };
    } catch {
      /* response wasn't JSON — still 2xx, so treat as success */
    }
    return { ok: true, status: res.status, environment };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      message: (err as Error).message || 'Network error reaching Nango',
    };
  }
}

export interface IntegrationProviderSettingsDeps {
  /** Override adapters in tests; production leaves this unset. */
  adapters?: ValidateAdapters;
  /**
   * Override the DB handle for tests. Production leaves this unset so
   * the store falls back to `getOrgsDb()`.
   */
  getDb?: () => Database.Database;
  /** Test hook — override `process.env.HUB_SHARED_NANGO_KEY` lookup. */
  getSharedKey?: () => string | undefined;
}

const VALID_MODES: ReadonlySet<IntegrationProviderMode> = new Set(['shared', 'byo']);
const VALID_PROVIDERS: ReadonlySet<IntegrationProviderId> = new Set([
  'nango-cloud',
  'nango-selfhosted',
]);

export default function createIntegrationProviderSettingsRoutes(
  _routeDeps: RouteDeps,
  extra: IntegrationProviderSettingsDeps = {},
): Router {
  const router = Router();
  const validateKey = extra.adapters?.validateNangoKey ?? defaultValidateNangoKey;
  const resolveDb = (): Database.Database | undefined => (extra.getDb ? extra.getDb() : undefined);
  const resolveSharedKey = (): string =>
    (extra.getSharedKey ? extra.getSharedKey() : process.env.HUB_SHARED_NANGO_KEY) || '';

  router.get(
    '/api/admin/integrations/provider',
    requireRole('Owner'),
    (_req: Request, res: Response) => {
      try {
        const db = resolveDb();
        res.json(db ? readIntegrationProviderMasked(db) : readIntegrationProviderMasked());
      } catch (err) {
        res.status(500).json({ error: (err as Error).message });
      }
    },
  );

  router.put(
    '/api/admin/integrations/provider',
    requireRole('Owner'),
    (req: Request, res: Response) => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const payload: IntegrationProviderWrite = {};

      if (body.mode !== undefined) {
        if (
          typeof body.mode !== 'string' ||
          !VALID_MODES.has(body.mode as IntegrationProviderMode)
        ) {
          return res.status(400).json({ error: "mode must be 'shared' or 'byo'" });
        }
        payload.mode = body.mode as IntegrationProviderMode;
      }
      if (body.provider !== undefined) {
        if (
          typeof body.provider !== 'string' ||
          !VALID_PROVIDERS.has(body.provider as IntegrationProviderId)
        ) {
          return res
            .status(400)
            .json({ error: "provider must be 'nango-cloud' or 'nango-selfhosted'" });
        }
        payload.provider = body.provider as IntegrationProviderId;
      }
      const strKeys = ['secretKey', 'providerBaseUrl', 'webhookSecret'] as const;
      for (const k of strKeys) {
        const v = body[k];
        if (v === undefined) continue;
        if (v === null) {
          payload[k] = '';
        } else if (typeof v !== 'string') {
          return res.status(400).json({ error: `${k} must be a string` });
        } else {
          payload[k] = v;
        }
      }
      if (body.enabled !== undefined) payload.enabled = body.enabled === true;

      // Refuse a no-op PUT that would simply drop a BYO key by switching
      // to shared mode without populating the env var. Operators almost
      // certainly mean to leave shared mode disabled in that case;
      // surfacing the gap loudly avoids a silent regression where every
      // Connect button reads "operator hasn't configured Nango".
      if (payload.mode === 'shared' && !resolveSharedKey()) {
        return res.status(400).json({
          error:
            'Cannot switch to shared mode: HUB_SHARED_NANGO_KEY is not set in the server environment.',
        });
      }

      try {
        const db = resolveDb();
        const who = (req as AuthenticatedRequest).authUserId || '';
        const after = db
          ? writeIntegrationProviderConfig(payload, who, db)
          : writeIntegrationProviderConfig(payload, who);
        res.json(after);
      } catch (err) {
        res.status(500).json({ error: (err as Error).message });
      }
    },
  );

  router.post(
    '/api/admin/integrations/provider/validate',
    requireRole('Owner'),
    async (req: Request, res: Response) => {
      const db = resolveDb();
      const saved = db ? readIntegrationProviderRow(db) : readIntegrationProviderRow();
      const incoming = (req.body ?? {}) as Record<string, unknown>;

      // The caller can pass an unsaved candidate secret/baseUrl/mode
      // for "validate before save". MASK preserves the stored value,
      // so the UI can pre-fill from the masked GET payload and only
      // the truly-new key gets sent over the wire.
      const candidateMode: IntegrationProviderMode =
        (typeof incoming.mode === 'string' &&
        VALID_MODES.has(incoming.mode as IntegrationProviderMode)
          ? (incoming.mode as IntegrationProviderMode)
          : null) ?? saved.mode;

      // Shared mode — env var is implicitly trusted. We deliberately
      // don't *use* the env key to call Nango from this route to avoid
      // ever leaking it via stack traces / log lines on a broken
      // outbound network path. The runtime resolver does that on a
      // real request when the user clicks Connect.
      if (candidateMode === 'shared') {
        const sharedAvailable = !!resolveSharedKey();
        return res.json({
          ok: sharedAvailable,
          mode: 'shared',
          message: sharedAvailable
            ? 'Shared mode — HUB_SHARED_NANGO_KEY is present (validation skipped — implicitly trusted).'
            : 'Shared mode — HUB_SHARED_NANGO_KEY is not set in the server environment.',
        });
      }

      const candidateBaseUrl =
        (typeof incoming.providerBaseUrl === 'string' && incoming.providerBaseUrl) ||
        saved.providerBaseUrl ||
        DEFAULT_NANGO_BASE_URL;

      const incomingSecret = incoming.secretKey;
      const candidateSecret =
        typeof incomingSecret === 'string' && incomingSecret !== MASK && incomingSecret !== ''
          ? incomingSecret
          : saved.secretKey;

      try {
        const result = await validateKey(candidateSecret, candidateBaseUrl);
        res.json({ ...result, mode: 'byo' });
      } catch (err) {
        res.json({ ok: false, mode: 'byo', message: (err as Error).message });
      }
    },
  );

  return router;
}
