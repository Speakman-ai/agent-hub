import type { OrgRow, ServerConnection } from './types.js';

/** Translate the public vocabulary only. orgs.db and its identifiers stay canonical. */
export function toServerConnection(row: OrgRow): ServerConnection {
  return {
    id: row.id,
    name: row.name,
    mode: row.mode,
    color: row.color,
    remoteUrl: row.remote_url,
    apiKey: row.api_key,
    position: row.position,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
