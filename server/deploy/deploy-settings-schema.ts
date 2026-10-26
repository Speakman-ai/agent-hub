/** DDL for deploy environments and the PR environment block saved from the Deployments settings UI (see deploy-settings-store.ts). */
export const DEPLOYMENT_PROJECT_SETTINGS_SCHEMA = `
  CREATE TABLE IF NOT EXISTS deployment_project_settings (
    project_id TEXT PRIMARY KEY,
    -- JSON object in the deploy.yaml "environments:" wire shape.
    environments TEXT NOT NULL,
    -- JSON object in the deploy.yaml "preview:" wire shape; NULL = no PR environments.
    preview TEXT,
    updated_by TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`;
