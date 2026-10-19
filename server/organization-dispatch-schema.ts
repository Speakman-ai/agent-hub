import type Database from 'better-sqlite3';

/**
 * Audit and idempotency records for organization-agent dispatch to project agents.
 * One row per (initiating organization session, idempotency key). Rejected and failed
 * attempts are kept too, so the trail shows who asked for what even when nothing ran.
 * Target sessions stay in `sessions`, owned by the acting user; this table never owns them.
 */
export function ensureOrganizationDispatchSchema(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS organization_dispatch_requests (
    id TEXT PRIMARY KEY,
    server_id TEXT NOT NULL,
    organization_id TEXT NOT NULL,
    organization_agent_id TEXT NOT NULL,
    workspace_id TEXT NOT NULL,
    initiating_session_id TEXT NOT NULL,
    acting_user_id TEXT NOT NULL,
    target_project_id TEXT NOT NULL,
    target_agent_id TEXT NOT NULL,
    idempotency_key TEXT NOT NULL,
    payload_hash TEXT NOT NULL,
    session_name TEXT NOT NULL,
    prompt TEXT NOT NULL,
    status TEXT NOT NULL
      CHECK(status IN ('queued','starting','accepted','rejected','failed','revoked','expired')),
    outcome_code TEXT,
    outcome_message TEXT,
    target_session_id TEXT,
    config_version TEXT,
    link_id TEXT,
    attempts INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    accepted_at TEXT,
    UNIQUE (server_id, initiating_session_id, idempotency_key)
  );
  CREATE INDEX IF NOT EXISTS idx_organization_dispatch_queue
    ON organization_dispatch_requests(server_id, status, created_at);
  CREATE INDEX IF NOT EXISTS idx_organization_dispatch_target
    ON organization_dispatch_requests(server_id, organization_id, acting_user_id, target_agent_id, status);
  CREATE INDEX IF NOT EXISTS idx_organization_dispatch_session
    ON organization_dispatch_requests(target_session_id);`);
}
