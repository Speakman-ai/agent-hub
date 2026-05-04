/**
 * Shared DDL for the `integration_providers` singleton table.
 *
 * Singleton row (`CHECK(id = 1)`) lives on `orgs.db` and stores the
 * operator-level Nango (or future) integration-provider configuration:
 *
 *   - `mode` toggles between `shared` (Hub-Shared, uses
 *     `HUB_SHARED_NANGO_KEY` from the build env) and `byo` (operator
 *     pastes their own Nango secret).
 *   - `provider` is the adapter id (`nango-cloud` for V1; future
 *     `nango-selfhosted` and other providers reuse this row).
 *   - `secret_key_encrypted` and `webhook_secret_encrypted` are
 *     AES-256-GCM ciphertext blobs encrypted with the same key file
 *     `pr-env-secret.key` that `pr-env-store.ts` already manages —
 *     the `encryptSecret` / `decryptSecret` helpers are imported
 *     directly so we don't duplicate the key-management code.
 *   - `provider_base_url` lets operators point a self-hosted Nango
 *     install at a different URL without code changes.
 *
 * Mode/secret invariant — when `mode = 'shared'`, the DB never holds
 * the secret. The runtime resolver substitutes `HUB_SHARED_NANGO_KEY`
 * at read time so even an exfiltrated `orgs.db` carries no shared
 * credentials.
 *
 * Keep this file dependency-free — `orgs.ts` runs the DDL at boot, so
 * heavy imports here would re-introduce the circular-dependency hazard
 * that bit `pr-env-schema.ts`.
 */

export const INTEGRATION_PROVIDERS_SCHEMA = `
  CREATE TABLE IF NOT EXISTS integration_providers (
    id INTEGER PRIMARY KEY CHECK(id = 1),
    mode TEXT NOT NULL DEFAULT 'shared' CHECK(mode IN ('shared', 'byo')),
    provider TEXT NOT NULL DEFAULT 'nango-cloud' CHECK(provider IN ('nango-cloud', 'nango-selfhosted')),
    secret_key_encrypted TEXT NOT NULL DEFAULT '',
    provider_base_url TEXT NOT NULL DEFAULT '',
    webhook_secret_encrypted TEXT NOT NULL DEFAULT '',
    enabled INTEGER NOT NULL DEFAULT 1,
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_by TEXT NOT NULL DEFAULT ''
  );
`;
