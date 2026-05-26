import { existsSync, mkdirSync, readdirSync, symlinkSync } from 'fs';
import path from 'path';
import type { Project } from './types.js';
import config from './config.js';
import { writeProjectAwsConfigFile } from './project-aws-config-file.js';
import { hostCliHomePath } from './host-cli-home.js';
import type { ProjectAwsSsoProfilesMap } from './project-aws-profiles.js';

export function getProjectAwsSsoProfiles(project: Project): ProjectAwsSsoProfilesMap {
  const raw = (project as Project & { awsSsoProfiles?: ProjectAwsSsoProfilesMap }).awsSsoProfiles;
  if (!raw || typeof raw !== 'object') return {};
  return raw;
}

function awsSsoCacheHasTokens(cacheDir: string): boolean {
  try {
    if (!existsSync(cacheDir)) return false;
    return readdirSync(cacheDir).some((name) => name.endsWith('.json'));
  } catch {
    return false;
  }
}

/**
 * When a spawn uses per-user HOME but AWS SSO was completed via break-glass
 * (host HOME), link the host SSO cache into the spawn HOME so `aws` inside
 * Codex can still resolve credentials. Best-effort; never throws.
 */
export function ensureAwsSsoCacheInSpawnHome(
  env: NodeJS.ProcessEnv,
  dataDir: string = config.dataDir,
): void {
  const home = env.HOME?.trim();
  if (!home) return;
  const userCache = path.join(home, '.aws', 'sso', 'cache');
  if (awsSsoCacheHasTokens(userCache)) return;

  const hostCache = path.join(hostCliHomePath(dataDir), '.aws', 'sso', 'cache');
  if (!awsSsoCacheHasTokens(hostCache)) return;

  try {
    mkdirSync(path.dirname(userCache), { recursive: true, mode: 0o700 });
    if (existsSync(userCache)) return;
    const linkType = process.platform === 'win32' ? 'junction' : 'dir';
    symlinkSync(hostCache, userCache, linkType);
  } catch {
    /* non-fatal — spawn proceeds; user may need to re-login via Hub SSO API */
  }
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
    ensureAwsSsoCacheInSpawnHome(base);
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

/** True when the project has at least one configured AWS SSO profile name. */
export function projectHasAwsSsoProfiles(project: Project): boolean {
  return Object.keys(getProjectAwsSsoProfiles(project)).length > 0;
}
