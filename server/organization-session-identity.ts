import { getDb } from './db.js';

export interface OrganizationSessionIdentity {
  server_id: string;
  organization_id: string;
  workspace_id: string;
  agent_id: string;
}

export function organizationSessionIdentity(sessionId: string): OrganizationSessionIdentity | null {
  return (
    (getDb()
      .prepare('SELECT * FROM organization_workflow_sessions WHERE session_id = ?')
      .get(sessionId) as OrganizationSessionIdentity | undefined) ?? null
  );
}

export function recordOrganizationSessionIdentity(
  sessionId: string,
  identity: OrganizationSessionIdentity,
): void {
  getDb()
    .prepare(
      `INSERT INTO organization_workflow_sessions (session_id, server_id, organization_id, workspace_id, agent_id)
    VALUES (?, ?, ?, ?, ?) ON CONFLICT(session_id) DO NOTHING`,
    )
    .run(
      sessionId,
      identity.server_id,
      identity.organization_id,
      identity.workspace_id,
      identity.agent_id,
    );
}
