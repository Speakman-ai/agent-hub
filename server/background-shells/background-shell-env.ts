import config, { buildSpawnEnv, resolveAgentHubApiBaseForSpawn } from '../config.js';
import { mergeProjectAwsSpawnEnv, projectHasAwsSsoProfiles } from '../project-aws-spawn.js';
import type { Project, SessionRow } from '../types.js';

/** Background shells use the same profile files and SSO cache HOME as their owner. */
export function buildBackgroundShellEnv(
  session: SessionRow,
  project: Project | null,
): NodeJS.ProcessEnv {
  const env = buildSpawnEnv(config, {
    userId: session.owner_user_id ?? null,
    sessionId: session.id,
  });
  env.AGENT_HUB_SESSION_ID = session.id;
  env.AGENT_HUB_URL = resolveAgentHubApiBaseForSpawn(config);
  delete env.PROJECT_ID;
  if (project) {
    env.PROJECT_ID = project.id;
    if (projectHasAwsSsoProfiles(project) && !mergeProjectAwsSpawnEnv(env, project)) {
      throw new Error('Could not prepare the project AWS profiles for this background shell');
    }
  }
  return env;
}
