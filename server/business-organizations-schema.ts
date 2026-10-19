import type Database from 'better-sqlite3';
/** Business groups are separate from the legacy `orgs` Server partitions.
 * Projects live in each Server's projects.json, so their existence is checked
 * by the store and their links are explicitly removed on project deletion.
 */
export const BUSINESS_ORGANIZATIONS_SCHEMA = `
  CREATE TABLE IF NOT EXISTS business_organizations (
    server_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    id TEXT NOT NULL,
    name TEXT NOT NULL CHECK(length(trim(name)) > 0),
    created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    archived_at TEXT,
    PRIMARY KEY (server_id, id)
  );
  CREATE INDEX IF NOT EXISTS idx_business_organizations_active
    ON business_organizations(server_id, archived_at, created_at, id);

  CREATE TABLE IF NOT EXISTS business_organization_projects (
    server_id TEXT NOT NULL,
    organization_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (server_id, organization_id, project_id),
    FOREIGN KEY (server_id, organization_id)
      REFERENCES business_organizations(server_id, id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_business_organization_projects_project
    ON business_organization_projects(server_id, project_id, organization_id);

  CREATE TABLE IF NOT EXISTS business_organization_members (
    server_id TEXT NOT NULL,
    organization_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    role TEXT NOT NULL CHECK(role IN ('Owner', 'Admin', 'Member')),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (server_id, organization_id, user_id),
    FOREIGN KEY (server_id, organization_id)
      REFERENCES business_organizations(server_id, id) ON DELETE CASCADE,
    FOREIGN KEY (user_id, server_id)
      REFERENCES memberships(user_id, org_id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_business_organization_members_user
    ON business_organization_members(server_id, user_id, organization_id);

  -- Roster snapshot taken when an organization is archived: the members who
  -- keep read access to their own history. Earlier removals are never in it.
  CREATE TABLE IF NOT EXISTS business_organization_archived_members (
    server_id TEXT NOT NULL,
    organization_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    PRIMARY KEY (server_id, organization_id, user_id),
    FOREIGN KEY (server_id, organization_id)
      REFERENCES business_organizations(server_id, id) ON DELETE CASCADE,
    FOREIGN KEY (user_id, server_id)
      REFERENCES memberships(user_id, org_id) ON DELETE CASCADE
  );
`;

/** Each link generation gets its own ID, so unlink-and-relink never revives memory
 * or cached context derived under the earlier link. Rerunnable. */
export function migrateBusinessOrganizationLinkIds(db: Database.Database): void {
  db.transaction(() => {
    const columns = db.prepare('PRAGMA table_info(business_organization_projects)').all() as Array<{
      name: string;
    }>;
    if (!columns.some((column) => column.name === 'link_id'))
      db.exec('ALTER TABLE business_organization_projects ADD COLUMN link_id TEXT');
    db.exec(
      'UPDATE business_organization_projects SET link_id = lower(hex(randomblob(16))) WHERE link_id IS NULL',
    );
  })();
}
