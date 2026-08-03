import { existsSync, mkdirSync, readdirSync, symlinkSync } from 'fs';
import path from 'path';
import type { Project } from './types.js';
import config from './config.js';
import { writeProjectAwsFiles } from './project-aws-config-file.js';
import { hostCliHomePath } from './host-cli-home.js';
import {
  resolveProjectAwsDefaultProfile,
  type ProjectAwsSsoProfilesMap,
} from './project-aws-profiles.js';

export function getProjectAwsSsoProfiles(project: Project): ProjectAwsSsoProfilesMap {
  const raw = (project as Project & { awsSsoProfiles?: ProjectAwsSsoProfilesMap }).awsSsoProfiles;
  if (!raw || typeof raw !== 'object') return {};
  return raw;
}

/** Operator-designated default profile stored on the project, if any. */
export function getProjectAwsDefaultProfile(project: Project): string | null {
  const raw = (project as Project & { awsDefaultProfile?: string }).awsDefaultProfile;
  if (typeof raw !== 'string') return null;
  const name = raw.trim();
  return name ? name : null;
}

function awsSsoCacheHasTokens(cacheDir: string): boolean {
  try {
    if (!existsSync(cacheDir)) return false;
    return readdirSync(cacheDir).some((name) => name.endsWith('.json'));
  } catch {
    return false;
  }
}

export interface MergeProjectAwsSpawnEnvOpts {
  /**
   * When the caller already wrote the project config (e.g. chat codex argv
   * planning), pass the path here to avoid a second `writeFileSync`.
   */
  configPath?: string;
  /** Pre-written project credentials file path paired with `configPath`. */
  credentialsPath?: string;
}

/**
 * Ambient AWS credential / profile-selection vars a spawn must not inherit
 * from the Hub server process: they would shadow the project-scoped config and
 * credentials files (e.g. an inherited `AWS_PROFILE` naming a profile that only
 * exists in the operator's own config).
 */
export const AWS_AMBIENT_CREDENTIAL_KEYS = [
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'AWS_SECURITY_TOKEN',
  'AWS_PROFILE',
  'AWS_DEFAULT_PROFILE',
] as const;

export function scrubAwsCredentialEnv(env: NodeJS.ProcessEnv): void {
  for (const key of AWS_AMBIENT_CREDENTIAL_KEYS) delete env[key];
}

/**
 * When a Codex spawn uses per-user HOME but AWS SSO login ran under break-glass
 * (host HOME), link the host SSO cache into the spawn HOME. Call only for
 * Codex spawns — other engines either use host HOME (Claude fallback) or the
 * same per-user HOME as the Hub SSO login API. Best-effort; never throws.
 */
export function linkAwsSsoHostCacheIntoSpawnHome(
  env: NodeJS.ProcessEnv,
  dataDir: string = config.dataDir,
): void {
  const home = env.HOME?.trim();
  if (!home) return;
  const userCache = path.join(home, '.aws', 'sso', 'cache');
  // If userCache already exists (including a stale symlink to an expired host
  // cache), we do not replace it — operators must remove ~/.aws/sso/cache under
  // the per-user HOME and re-run Hub SSO login to refresh tokens.
  if (awsSsoCacheHasTokens(userCache)) return;

  const hostCache = path.join(hostCliHomePath(dataDir), '.aws', 'sso', 'cache');
  if (!awsSsoCacheHasTokens(hostCache)) return;

  try {
    mkdirSync(path.dirname(userCache), { recursive: true, mode: 0o700 });
    if (existsSync(userCache)) return;
    const linkType = process.platform === 'win32' ? 'junction' : 'dir';
    symlinkSync(hostCache, userCache, linkType);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EEXIST') return;
    const summary = (err as Error).message
      .replace(/[\r\n|]+/g, ' ')
      .trim()
      .slice(0, 200);
    console.warn(
      `[project-aws] link host SSO cache into spawn HOME failed (${code ?? 'unknown'}): ${summary}`,
    );
  }
}

/**
 * Point spawned CLIs at a generated config ini for this project's SSO
 * profiles. SSO tokens still live under the user's HOME. Env-only — no
 * filesystem side effects (see `linkAwsSsoHostCacheIntoSpawnHome` for Codex).
 *
 * @returns Config file path when profiles are configured, else null.
 */
export function mergeProjectAwsSpawnEnv(
  base: NodeJS.ProcessEnv,
  project: Project,
  opts?: MergeProjectAwsSpawnEnvOpts,
): string | null {
  const profiles = getProjectAwsSsoProfiles(project);
  const names = Object.keys(profiles);
  if (names.length === 0) return null;
  try {
    const written =
      opts?.configPath?.trim() && opts.credentialsPath?.trim()
        ? { configPath: opts.configPath.trim(), credentialsPath: opts.credentialsPath.trim() }
        : writeProjectAwsFiles(project.id, profiles);
    const { configPath, credentialsPath } = written;
    scrubAwsCredentialEnv(base);
    base.AWS_CONFIG_FILE = configPath;
    base.AWS_SHARED_CREDENTIALS_FILE = credentialsPath;
    base.AGENT_HUB_AWS_PROFILE_NAMES = names.join(',');
    // Set AFTER the scrub: the scrub drops an *inherited* AWS_PROFILE naming a
    // profile that only exists in the operator's own config, this puts back a
    // project-scoped one so `aws …` without `--profile` resolves.
    const defaultProfile = resolveProjectAwsDefaultProfile(
      profiles,
      getProjectAwsDefaultProfile(project),
    );
    if (defaultProfile) base.AWS_PROFILE = defaultProfile;
    return configPath;
  } catch (err) {
    const summary = (err as Error).message
      .replace(/[\r\n|]+/g, ' ')
      .trim()
      .slice(0, 200);
    console.error(
      `TOOL_ERROR | ${new Date().toISOString()} | project-aws | spawn merge | error | ${summary} | ${JSON.stringify({ v: 2, sev: 'soft', resolution: 'recovered', tags: ['project-aws', 'spawn'] })}`,
    );
    return null;
  }
}

/** True when the project has at least one configured AWS SSO profile name. */
export function projectHasAwsSsoProfiles(project: Project): boolean {
  return Object.keys(getProjectAwsSsoProfiles(project)).length > 0;
}

/** @deprecated Use {@link linkAwsSsoHostCacheIntoSpawnHome}. */
export const ensureAwsSsoCacheInSpawnHome = linkAwsSsoHostCacheIntoSpawnHome;
