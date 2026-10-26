/**
 * Lazy access to saved Deployments settings for modules that must not open the
 * database at import time. `deploy-settings-store.ts` imports `db.ts`, whose
 * module load runs `initDb()`; PR-list, PR environment and Autopilot helpers
 * are imported by routes and tests that never touch the DB, so they load the
 * store on first use instead.
 */
import type { DeployConfig } from './deploy-config.js';

export async function loadStoredDeployConfig(projectId: string): Promise<DeployConfig | null> {
  const { storedDeployConfig } = await import('./deploy-settings-store.js');
  return storedDeployConfig(projectId);
}
