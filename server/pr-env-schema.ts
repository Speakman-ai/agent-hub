/**
 * Shared DDL for the `pr_env_config` singleton table.
 *
 * Extracted so `db.ts` (which runs migrations at boot) and
 * `pr-env-store.ts` (which owns read/write semantics) both reference the
 * same schema constant. Previously `db.ts` inlined a copy to avoid a
 * circular import, but a drift between the two copies would let tests
 * pass while prod broke, so both now import from here.
 *
 * Keep this file dependency-free — it's imported at module-init time by
 * db.ts, so pulling in heavier modules here risks re-introducing the
 * circular-dependency problem that motivated the inline copy.
 */

export const PR_ENV_CONFIG_SCHEMA = `
  CREATE TABLE IF NOT EXISTS pr_env_config (
    id INTEGER PRIMARY KEY CHECK(id = 1),
    enabled INTEGER NOT NULL DEFAULT 0,
    repo_full_name TEXT NOT NULL DEFAULT '',
    preview_host TEXT NOT NULL DEFAULT '',
    preview_base_url TEXT NOT NULL DEFAULT '',
    cert_renewal_live INTEGER NOT NULL DEFAULT 0,
    port_range_min INTEGER,
    port_range_max INTEGER,
    github_app_id TEXT NOT NULL DEFAULT '',
    github_installation_id TEXT NOT NULL DEFAULT '',
    github_private_key_enc TEXT NOT NULL DEFAULT '',
    route53_access_key_id TEXT NOT NULL DEFAULT '',
    route53_secret_access_key_enc TEXT NOT NULL DEFAULT '',
    route53_hosted_zone_id TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`;
