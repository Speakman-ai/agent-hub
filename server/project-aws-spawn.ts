import { lstatSync, readlinkSync, realpathSync, rmSync, unlinkSync } from 'fs';
import os from 'os';
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

/**
 * Operator-designated profile background collection runs as, if any. Separate
 * from the interactive default: that one is about which account a human means
 * when they omit `--profile`, this one about which credentials survive with
 * nobody watching.
 */
export function getProjectAwsMonitoringProfile(project: Project): string | null {
  const raw = (project as Project & { awsMonitoringProfile?: string }).awsMonitoringProfile;
  if (typeof raw !== 'string') return null;
  const name = raw.trim();
  return name ? name : null;
}

export interface MergeProjectAwsSpawnEnvOpts {
  /**
   * User whose per-user HOME the spawn runs under, or null when the spawn has
   * no owning user (it then runs under the host HOME).
   */
  ownerUserId: string | null;
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

export type AwsSsoCacheIsolation = { ok: true; detached: boolean } | { ok: false; reason: string };

type EntryKind = 'missing' | 'dir' | 'link' | 'other';

function entryKind(p: string): EntryKind {
  try {
    const st = lstatSync(p);
    if (st.isSymbolicLink()) return 'link';
    return st.isDirectory() ? 'dir' : 'other';
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return 'missing';
    throw err;
  }
}

function isWithin(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function realpathOrSelf(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

function refuse(reason: string): AwsSsoCacheIsolation {
  return { ok: false, reason: `${reason} Refusing to run AWS until this is fixed.` };
}

function isolationFailure(err: unknown, what: string): AwsSsoCacheIsolation {
  const code = (err as NodeJS.ErrnoException).code;
  const summary = (err as Error).message
    .replace(/[\r\n|]+/g, ' ')
    .trim()
    .slice(0, 200);
  console.warn(`[project-aws] ${what} failed (${code ?? 'unknown'}): ${summary}`);
  return refuse(
    `Could not separate your AWS credentials from the shared host login (${what}: ${code ?? 'unknown'}).`,
  );
}

/**
 * SSO credentials belong to the user who signed in, so an owning user's AWS
 * work must run against AWS state that lives in their own per-user HOME and
 * was never shared with the host. Two caches matter:
 *
 *   - `~/.aws/sso/cache`: the SSO access token.
 *   - `~/.aws/cli/cache`: role credentials the CLI derived from that token,
 *     reused until they expire without rereading the token.
 *
 * Invariant: the HOME does not resolve into the host HOME, and every
 * directory on the way to those caches (`.aws`, `.aws/sso`, `.aws/cli`, and
 * the caches themselves) is a real directory, not a link. Anything else could
 * read the host's credentials or, during cleanup, delete them, so it fails
 * closed rather than being repaired.
 *
 * The single exception is the link spawns used to create from
 * `~/.aws/sso/cache` to the host cache. That HOME is tainted: its derived CLI
 * cache was filled from the host's token. Repair clears the derived cache
 * first, then removes the link (only the link, never the host cache), so a
 * failure part-way leaves the link and the next call retries.
 *
 * Returns `ok: false` whenever the invariant cannot be established; callers
 * must then not run AWS for that user. A null owner is the host itself and
 * always passes. Never throws.
 */
export function ensurePrivateAwsSsoCache(
  env: NodeJS.ProcessEnv,
  ownerUserId: string | null,
  dataDir: string = config.dataDir,
): AwsSsoCacheIsolation {
  if (!ownerUserId?.trim()) return { ok: true, detached: false };
  const home = env.HOME?.trim();
  const hostHome = hostCliHomePath(dataDir);
  if (!home || isWithin(realpathOrSelf(home), realpathOrSelf(hostHome))) {
    return refuse('Your per-user HOME is unavailable, so AWS SSO would use the shared host login.');
  }
  const userAws = path.join(home, '.aws');
  const ssoCache = path.join(userAws, 'sso', 'cache');
  const cliCache = path.join(userAws, 'cli', 'cache');
  const hostCache = path.join(hostHome, '.aws', 'sso', 'cache');

  let ssoCacheKind: EntryKind;
  let cliCacheKind: EntryKind;
  try {
    for (const dir of [userAws, path.join(userAws, 'sso'), path.join(userAws, 'cli')]) {
      const kind = entryKind(dir);
      if (kind !== 'missing' && kind !== 'dir') {
        return refuse(`${dir} is not a private directory.`);
      }
    }
    ssoCacheKind = entryKind(ssoCache);
    cliCacheKind = entryKind(cliCache);
  } catch (err) {
    return isolationFailure(err, 'inspect AWS directories');
  }

  if (cliCacheKind !== 'missing' && cliCacheKind !== 'dir') {
    return refuse(`${cliCache} is not a private directory.`);
  }
  if (ssoCacheKind === 'missing' || ssoCacheKind === 'dir') return { ok: true, detached: false };
  if (ssoCacheKind !== 'link') return refuse(`${ssoCache} is not a private directory.`);

  let target: string;
  try {
    target = path.resolve(path.dirname(ssoCache), readlinkSync(ssoCache));
  } catch (err) {
    return isolationFailure(err, 'inspect SSO cache link');
  }
  if (target !== path.resolve(hostCache)) {
    return refuse(`${ssoCache} links to ${target} instead of being a private directory.`);
  }

  // Parents were verified as real directories above, so the recursive delete
  // stays inside this user's HOME.
  try {
    if (cliCacheKind === 'dir') rmSync(cliCache, { recursive: true, force: true });
  } catch (err) {
    return isolationFailure(err, 'clear cached role credentials');
  }
  try {
    unlinkSync(ssoCache);
  } catch (err) {
    return isolationFailure(err, 'remove shared SSO cache link');
  }
  return { ok: true, detached: true };
}

/**
 * Point every AWS profile source at the null device so the CLI and SDKs
 * resolve no profile, and therefore never read an SSO token cache.
 */
export function disableProjectAwsSpawnEnv(env: NodeJS.ProcessEnv, reason: string): void {
  scrubAwsCredentialEnv(env);
  env.AWS_CONFIG_FILE = os.devNull;
  env.AWS_SHARED_CREDENTIALS_FILE = os.devNull;
  delete env.AGENT_HUB_AWS_PROFILE_NAMES;
  env.AGENT_HUB_AWS_DISABLED_REASON = reason;
}

/**
 * Point spawned CLIs at a generated config ini for this project's profiles,
 * and keep the owner's SSO state private (`ensurePrivateAwsSsoCache`). When
 * that cannot be guaranteed the spawn gets no AWS access at all
 * (`disableProjectAwsSpawnEnv`) and this returns null.
 *
 * `opts.ownerUserId` is required so every spawn site states whose HOME the
 * spawn runs under; pass null only for spawns with no owning user.
 *
 * @returns Config file path when profiles are configured and usable, else null.
 */
export function mergeProjectAwsSpawnEnv(
  base: NodeJS.ProcessEnv,
  project: Project,
  opts: MergeProjectAwsSpawnEnvOpts,
): string | null {
  const profiles = getProjectAwsSsoProfiles(project);
  const names = Object.keys(profiles);
  if (names.length === 0) return null;
  try {
    const written =
      opts.configPath?.trim() && opts.credentialsPath?.trim()
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
    const isolation = ensurePrivateAwsSsoCache(base, opts.ownerUserId);
    if (!isolation.ok) {
      console.warn(`[project-aws] AWS disabled for spawn: ${isolation.reason}`);
      disableProjectAwsSpawnEnv(base, isolation.reason);
      return null;
    }
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
