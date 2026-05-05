/**
 * MCP servers DDL — kept in its own module so `orgs.ts` (which initialises
 * the orgs DB and applies the schema) can import it without pulling in the
 * full `mcp-servers-store.ts` (which depends on `orgs.ts` for `getOrgsDb`).
 */
export const MCP_SERVERS_SCHEMA = `
  CREATE TABLE IF NOT EXISTS mcp_servers (
    id                       TEXT PRIMARY KEY,
    user_id                  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name                     TEXT NOT NULL,
    catalog_id               TEXT,
    transport                TEXT NOT NULL CHECK(transport IN ('stdio','http')),
    command                  TEXT NOT NULL DEFAULT '',
    args_json                TEXT NOT NULL DEFAULT '[]',
    url                      TEXT NOT NULL DEFAULT '',
    env_encrypted_json       TEXT NOT NULL DEFAULT '',
    headers_encrypted_json   TEXT NOT NULL DEFAULT '',
    enabled                  INTEGER NOT NULL DEFAULT 1,
    created_at               TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at               TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_mcp_servers_user_id ON mcp_servers(user_id);
  CREATE INDEX IF NOT EXISTS idx_mcp_servers_user_enabled ON mcp_servers(user_id, enabled);
`;
