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
 *
 * SCOPE: This singleton holds **host-level** PR-env infrastructure
 * (preview host, base URL, port pool range, Route 53 hosted-zone wiring).
 * GitHub App credentials are deliberately NOT here — the dispatcher
 * reuses the registered Reviewer App (`AppConfig.githubApp`) so an
 * operator only registers one GitHub App per install. Per-PR /
 * per-project knobs (start script, internal port, Dockerfile path) live
 * on the JSON-backed `Project` (see `PrEnvProjectConfig` in types.ts).
 *
 * The `repo_full_name` and singleton `enabled` flag are retained for
 * backwards compatibility with the legacy single-repo install but are
 * no longer the source of truth for whether a PR-env should build —
 * `Project.prEnv.enabled` is.
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
    route53_access_key_id TEXT NOT NULL DEFAULT '',
    route53_secret_access_key_enc TEXT NOT NULL DEFAULT '',
    route53_hosted_zone_id TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`;

/**
 * Idempotent migration: drop the legacy GitHub App columns from existing
 * installs that were created before the Reviewer-App reuse change.
 *
 * SQLite 3.35+ supports `ALTER TABLE … DROP COLUMN`; better-sqlite3 ships
 * a recent enough SQLite. Statements are run individually so a partial
 * application (e.g. one column already gone, two still present) makes
 * progress instead of bailing on the first error. db.ts wraps each in
 * try/catch — column-not-found is the expected steady-state error once
 * the migration has run.
 */
export const PR_ENV_CONFIG_DROP_LEGACY_GITHUB_COLUMNS: string[] = [
  'ALTER TABLE pr_env_config DROP COLUMN github_app_id',
  'ALTER TABLE pr_env_config DROP COLUMN github_installation_id',
  'ALTER TABLE pr_env_config DROP COLUMN github_private_key_enc',
];
