/**
 * Integration-provider configuration store (Nango Shared/BYO toggle).
 *
 * Backs `/api/admin/integrations/provider`. The DB row is a singleton
 * (enforced by `CHECK(id=1)` on `integration_providers`) and lives on
 * `orgs.db` — Nango credentials are operator-level, not per-org. See the
 * "Integration Provider — Nango vs Maton ADR" wiki page for the broader
 * design.
 *
 * Two modes:
 *   - `shared` (default for cloud installs) — the operator does nothing.
 *     The DB carries no secret; the runtime resolver substitutes
 *     `HUB_SHARED_NANGO_KEY` from the process env. Validate is skipped
 *     for shared mode (the env var is implicitly trusted; if it's
 *     missing the resolver bubbles that up).
 *   - `byo` (default for self-hosted) — the operator pastes their own
 *     Nango secret in Settings → Admin → Integrations. Behaves like a
 *     normal masked-secret form.
 *
 * Switching modes is allowed but the UI surfaces a confirm dialog
 * because existing user `connection_id`s in the other mode become
 * unreachable until the user re-connects. We deliberately do NOT
 * migrate connection IDs across Nango projects.
 *
 * Encryption reuses `encryptSecret` / `decryptSecret` from
 * `pr-env-store.ts` — same per-install AES-256-GCM key file
 * (`<dataDir>/pr-env-secret.key`). No new key material is introduced.
 *
 * The store exposes three shapes:
 *   - `readIntegrationProviderRow()` — raw DB row (used by the runtime
 *     resolver).
 *   - `readIntegrationProviderMasked()` — for GET /admin/integrations
 *     /provider; secrets replaced with `••••••••` (`MASK`) when set.
 *     Includes a `sharedAvailable` flag (`HUB_SHARED_NANGO_KEY`
 *     present in env) so the UI can render the read-only banner
 *     correctly.
 *   - `writeIntegrationProviderConfig(partial, who)` — PUT;
 *     `undefined`/`MASK`-valued secret fields preserve the prior
 *     ciphertext, and switching to shared mode wipes the BYO secret
 *     ciphertext from disk.
 */

import type Database from 'better-sqlite3';
import { getOrgsDb } from './orgs.js';
import { encryptSecret, decryptSecret, MASK } from './pr-env-store.js';

export { MASK };

export type IntegrationProviderMode = 'shared' | 'byo';
export type IntegrationProviderId = 'nango-cloud' | 'nango-selfhosted';

/** Raw (plaintext) shape of the singleton row. */
export interface IntegrationProviderRow {
  mode: IntegrationProviderMode;
  provider: IntegrationProviderId;
  secretKey: string;
  providerBaseUrl: string;
  webhookSecret: string;
  enabled: boolean;
  updatedAt: string;
  updatedBy: string;
}

/** Masked shape returned by GET. */
export interface IntegrationProviderMasked {
  mode: IntegrationProviderMode;
  provider: IntegrationProviderId;
  /** True when a BYO secret is stored in DB. Always false in shared mode. */
  hasKey: boolean;
  /** True when `HUB_SHARED_NANGO_KEY` is present in process.env. */
  sharedAvailable: boolean;
  baseUrl: string;
  /** True when a BYO webhook secret is stored. */
  hasWebhookSecret: boolean;
  enabled: boolean;
  updatedAt: string;
  updatedBy: string;
}

/**
 * Partial write payload. Any field left `undefined` OR explicitly equal
 * to the mask sentinel preserves the prior value. This lets the UI POST
 * the whole form back without knowing which secrets the user touched.
 */
export type IntegrationProviderWrite = Partial<{
  mode: IntegrationProviderMode;
  provider: IntegrationProviderId;
  secretKey: string;
  providerBaseUrl: string;
  webhookSecret: string;
  enabled: boolean;
}>;

interface RawRow {
  id: number;
  mode: string;
  provider: string;
  secret_key_encrypted: string;
  provider_base_url: string;
  webhook_secret_encrypted: string;
  enabled: number;
  updated_at: string;
  updated_by: string;
}

const EMPTY_ROW: IntegrationProviderRow = {
  mode: 'shared',
  provider: 'nango-cloud',
  secretKey: '',
  providerBaseUrl: '',
  webhookSecret: '',
  enabled: true,
  updatedAt: '',
  updatedBy: '',
};

function hydrate(raw: RawRow): IntegrationProviderRow {
  return {
    mode: (raw.mode === 'byo' ? 'byo' : 'shared') as IntegrationProviderMode,
    provider: (raw.provider === 'nango-selfhosted'
      ? 'nango-selfhosted'
      : 'nango-cloud') as IntegrationProviderId,
    secretKey: raw.secret_key_encrypted ? decryptSecret(raw.secret_key_encrypted) : '',
    providerBaseUrl: raw.provider_base_url,
    webhookSecret: raw.webhook_secret_encrypted ? decryptSecret(raw.webhook_secret_encrypted) : '',
    enabled: raw.enabled === 1,
    updatedAt: raw.updated_at,
    updatedBy: raw.updated_by,
  };
}

function fetchRaw(db: Database.Database): RawRow | undefined {
  return db.prepare('SELECT * FROM integration_providers WHERE id = 1').get() as RawRow | undefined;
}

function resolveDb(db?: Database.Database): Database.Database {
  return db ?? getOrgsDb();
}

/**
 * True when `HUB_SHARED_NANGO_KEY` is populated in the process env.
 * Cloud builds bake this in via deploy pipeline; self-hosted installs
 * leave it unset, so the UI shows the BYO form by default.
 */
export function sharedNangoKeyAvailable(): boolean {
  const v = process.env.HUB_SHARED_NANGO_KEY;
  return typeof v === 'string' && v.length > 0;
}

/** Raw (plaintext) read. Missing row → empty-default shape. */
export function readIntegrationProviderRow(db?: Database.Database): IntegrationProviderRow {
  const raw = fetchRaw(resolveDb(db));
  if (!raw) return { ...EMPTY_ROW };
  return hydrate(raw);
}

/**
 * Masked read for GET. In shared mode the BYO ciphertext is *never*
 * surfaced — `hasKey` reports the env var, not the DB. This keeps the
 * UI from showing "secret stored" for a row that may still carry
 * ciphertext from a previous BYO session that was switched back to
 * shared without a wipe.
 */
export function readIntegrationProviderMasked(db?: Database.Database): IntegrationProviderMasked {
  const row = readIntegrationProviderRow(db);
  const sharedAvailable = sharedNangoKeyAvailable();
  return {
    mode: row.mode,
    provider: row.provider,
    hasKey: row.mode === 'byo' ? !!row.secretKey : false,
    sharedAvailable,
    baseUrl: row.providerBaseUrl,
    hasWebhookSecret: !!row.webhookSecret,
    enabled: row.enabled,
    updatedAt: row.updatedAt,
    updatedBy: row.updatedBy,
  };
}

/** Returns true iff the singleton row exists. */
export function integrationProviderRowExists(db?: Database.Database): boolean {
  return !!fetchRaw(resolveDb(db));
}

/**
 * Merge a partial update into the singleton row.
 *
 * Preservation rules (prevents partial UI saves from wiping secrets):
 *   - `undefined`  → keep existing
 *   - `MASK`       → keep existing (UI sends MASK for untouched fields)
 *   - `''`         → write-through (user explicitly cleared the field)
 *   - anything else → write-through
 *
 * Mode side-effects:
 *   - Switching `byo → shared` clears the BYO secret ciphertext on
 *     disk so an attacker who gets read-only access to `orgs.db` later
 *     can't lift a stale BYO key. The base URL is left intact (it's
 *     not sensitive) so a later switch back to BYO can reuse the
 *     operator's preferred URL.
 *
 * `who` is recorded in `updated_by` for audit. Pass an empty string in
 * tests / cron contexts where there's no user identity available.
 */
export function writeIntegrationProviderConfig(
  partial: IntegrationProviderWrite,
  who: string,
  db?: Database.Database,
): IntegrationProviderMasked {
  const handle = resolveDb(db);
  const existing = readIntegrationProviderRow(handle);

  const pickStr = <K extends 'secretKey' | 'webhookSecret' | 'providerBaseUrl'>(key: K): string => {
    const next = partial[key];
    if (next === undefined) return existing[key];
    if (typeof next !== 'string') return existing[key];
    if ((key === 'secretKey' || key === 'webhookSecret') && next === MASK) return existing[key];
    return next;
  };

  const nextMode: IntegrationProviderMode = partial.mode ?? existing.mode;
  const nextProvider: IntegrationProviderId = partial.provider ?? existing.provider;
  const nextEnabled: boolean = partial.enabled ?? existing.enabled;
  const nextBaseUrl = pickStr('providerBaseUrl');

  // Shared mode never persists a BYO secret. Switching byo→shared
  // wipes the prior ciphertext so the row never carries a stale key.
  let nextSecretKey: string;
  let nextWebhookSecret: string;
  if (nextMode === 'shared') {
    nextSecretKey = '';
    nextWebhookSecret = '';
  } else {
    nextSecretKey = pickStr('secretKey');
    nextWebhookSecret = pickStr('webhookSecret');
  }

  const secretEnc = nextSecretKey ? encryptSecret(nextSecretKey) : '';
  const webhookEnc = nextWebhookSecret ? encryptSecret(nextWebhookSecret) : '';

  handle
    .prepare(
      `INSERT INTO integration_providers (
         id, mode, provider, secret_key_encrypted, provider_base_url,
         webhook_secret_encrypted, enabled, updated_at, updated_by
       ) VALUES (1, ?, ?, ?, ?, ?, ?, datetime('now'), ?)
       ON CONFLICT(id) DO UPDATE SET
         mode = excluded.mode,
         provider = excluded.provider,
         secret_key_encrypted = excluded.secret_key_encrypted,
         provider_base_url = excluded.provider_base_url,
         webhook_secret_encrypted = excluded.webhook_secret_encrypted,
         enabled = excluded.enabled,
         updated_at = excluded.updated_at,
         updated_by = excluded.updated_by`,
    )
    .run(
      nextMode,
      nextProvider,
      secretEnc,
      nextBaseUrl,
      webhookEnc,
      nextEnabled ? 1 : 0,
      who || '',
    );

  return readIntegrationProviderMasked(handle);
}
