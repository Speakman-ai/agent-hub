/**
 * Runners table DDL — kept in a sibling module so unit tests can apply
 * the identical schema to an in-memory DB without pulling in `db.ts`.
 *
 * Owned by `runners-store.ts`. Wired into per-org `agent-hub.db` from
 * `db.ts#initDb` so each org has its own runner roster.
 */
export const RUNNERS_SCHEMA = `
  CREATE TABLE IF NOT EXISTS runners (
    id TEXT PRIMARY KEY,
    org_id TEXT NOT NULL,
    name TEXT NOT NULL,
    token_hash TEXT NOT NULL,
    capabilities TEXT NOT NULL DEFAULT '{}',
    status TEXT NOT NULL DEFAULT 'offline' CHECK(status IN ('offline','online')),
    last_seen_at TEXT,
    last_used_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_runners_org ON runners(org_id);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_runners_org_name ON runners(org_id, name);
`;

/**
 * Phase 3 migration — add `last_used_at` to pre-existing rows. The
 * column tracks the last time the dispatcher selected this runner so
 * round-robin among capability-equivalent runners has a fairness
 * signal. Idempotent: callers wrap the ALTER in try/catch so re-running
 * `initDb` against an already-migrated DB is a no-op.
 *
 * Backfill is not required — `NULL` sorts before any ISO timestamp in
 * the dispatcher's `lastUsedAt ASC` ordering, which is correct: a
 * runner that was never picked should be picked first.
 */
export const RUNNERS_MIGRATION_LAST_USED_AT = `
  ALTER TABLE runners ADD COLUMN last_used_at TEXT
`;
