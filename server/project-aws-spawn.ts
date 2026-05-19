import type { Project } from './types.js';
import { writeProjectAwsConfigFile } from './project-aws-config-file.js';
import type { ProjectAwsSsoProfilesMap } from './project-aws-profiles.js';

export function getProjectAwsSsoProfiles(project: Project): ProjectAwsSsoProfilesMap {
  const raw = (project as Project & { awsSsoProfiles?: ProjectAwsSsoProfilesMap }).awsSsoProfiles;
  if (!raw || typeof raw !== 'object') return {};
  return raw;
}

/**
 * Point spawned CLIs at a generated config ini for this project's SSO
 * profiles. SSO tokens are still cached under the user's HOME.
 */
export function mergeProjectAwsSpawnEnv(base: NodeJS.ProcessEnv, project: Project): void {
  const profiles = getProjectAwsSsoProfiles(project);
  const names = Object.keys(profiles);
  if (names.length === 0) return;
  try {
    const configPath = writeProjectAwsConfigFile(project.id, profiles);
    base.AWS_CONFIG_FILE = configPath;
    base.AGENT_HUB_AWS_PROFILE_NAMES = names.join(',');
  } catch (err) {
    const summary = (err as Error).message
      .replace(/[\r\n|]+/g, ' ')
      .trim()
      .slice(0, 200);
    console.error(
      `TOOL_ERROR | ${new Date().toISOString()} | project-aws | spawn merge | error | ${summary} | ${JSON.stringify({ v: 2, sev: 'soft', resolution: 'recovered', tags: ['project-aws', 'spawn'] })}`,
    );
  }
}
