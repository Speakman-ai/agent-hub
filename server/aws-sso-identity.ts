/**
 * AWS SSO identity probing, scoped to the caller's own HOME.
 *
 * The AWS CLI keys its SSO **token cache** off `$HOME/.aws/sso/cache`.
 * `AWS_CONFIG_FILE` only relocates the profile config, never the token cache.
 * So whichever HOME a probe runs under decides which cached token it sees.
 *
 * Agent Hub resolves HOME per caller:
 *   - Break-glass `x-api-key` with no owning user: the shared host HOME
 *     (`<dataDir>/host-creds/home`).
 *   - A Hub user: that user's per-user HOME
 *     (`<dataDir>/per-user-creds/<userId>/home`).
 *
 * SSO credentials belong to the person who signed in, so a user's status is
 * read from their own HOME only. There is no fallback to the host HOME: a
 * token an operator left there is someone else's identity, and reporting it
 * as the user's login would hand every user the same AWS principal.
 */
import { spawn, type ChildProcess } from 'child_process';
import config, { buildSpawnEnv } from './config.js';
import type { AppConfig } from './types.js';
import { ensurePrivateAwsSsoCache } from './project-aws-spawn.js';

export interface AwsSsoIdentity {
  ok: boolean;
  account?: string;
  arn?: string;
  userId?: string;
  error?: string;
  needsLogin?: boolean;
}

/**
 * Which HOME's token cache the status describes: `caller` for a user's own
 * per-user HOME, `host` for the shared operator HOME (no owning user).
 */
export type AwsHomeSource = 'caller' | 'host';

export interface AwsSsoStatusResult extends AwsSsoIdentity {
  homeSource: AwsHomeSource;
}

/** Injectable identity runner — defaults to the real `aws sts` spawn. */
export type RunAwsStsIdentity = (
  env: NodeJS.ProcessEnv,
  profile: string,
) => Promise<AwsSsoIdentity>;

/** Injectable env builder — defaults to the real `buildSpawnEnv`. */
export type BuildAwsSpawnEnv = (userId: string | null) => NodeJS.ProcessEnv;

export interface CheckAwsSsoStatusOpts {
  /** Caller-resolved user id (`authUserId`), or null for break-glass / host. */
  userId: string | null;
  /** Rendered `AWS_CONFIG_FILE` for the project's profiles. */
  configPath: string;
  /** Rendered `AWS_SHARED_CREDENTIALS_FILE` for the project's static profiles. */
  credentialsPath?: string;
  /** Configured profile name to probe. */
  profile: string;
  /** Data dir override (tests). Defaults to `config.dataDir`. */
  dataDir?: string;
  /** Identity runner override (tests). Defaults to `runAwsStsIdentity`. */
  run?: RunAwsStsIdentity;
  /** Env builder override (tests). Defaults to `buildSpawnEnv(config, ...)`. */
  buildEnv?: BuildAwsSpawnEnv;
}

function scrubAwsCredentialEnv(env: NodeJS.ProcessEnv): void {
  delete env.AWS_ACCESS_KEY_ID;
  delete env.AWS_SECRET_ACCESS_KEY;
  delete env.AWS_SESSION_TOKEN;
  delete env.AWS_SECURITY_TOKEN;
  delete env.AWS_PROFILE;
  delete env.AWS_DEFAULT_PROFILE;
}

/**
 * Probe the caller's own HOME and nothing else. Never reads the shared host
 * HOME on behalf of a user, and never another user's per-user HOME.
 */
export async function checkAwsSsoStatusForCaller(
  opts: CheckAwsSsoStatusOpts,
  cfg: AppConfig = config,
): Promise<AwsSsoStatusResult> {
  const dataDir = opts.dataDir ?? cfg.dataDir;
  const run = opts.run ?? runAwsStsIdentity;
  const buildEnv = opts.buildEnv ?? ((userId: string | null) => buildSpawnEnv(cfg, { userId }));

  const env = buildEnv(opts.userId);
  scrubAwsCredentialEnv(env);
  env.AWS_CONFIG_FILE = opts.configPath;
  if (opts.credentialsPath) env.AWS_SHARED_CREDENTIALS_FILE = opts.credentialsPath;
  if (!opts.userId) {
    const out = await run(env, opts.profile);
    return { ...out, homeSource: 'host' };
  }
  // An owning user is only ever probed against their own cache. If that cannot
  // be guaranteed, report logged out instead of reading the host token.
  const isolation = ensurePrivateAwsSsoCache(env, opts.userId, dataDir);
  if (!isolation.ok) {
    return { ok: false, error: isolation.reason, needsLogin: false, homeSource: 'caller' };
  }
  const out = await run(env, opts.profile);
  return { ...out, homeSource: 'caller' };
}

/**
 * Run `aws sts get-caller-identity` under the supplied env and parse the
 * result. Never throws — spawn / parse failures resolve to `{ ok: false }`.
 */
export function runAwsStsIdentity(
  env: NodeJS.ProcessEnv,
  profile: string,
): Promise<AwsSsoIdentity> {
  return new Promise((resolve) => {
    const proc = spawn(
      'aws',
      ['sts', 'get-caller-identity', '--profile', profile, '--output', 'json'],
      {
        // cwd is intentionally the always-existing server-process HOME, NOT
        // env.HOME: the SSO token cache is keyed off env.HOME (passed via
        // `env`), so cwd has no bearing on which token is read. Using
        // env.HOME as cwd would ENOENT-fail the spawn when a per-user HOME
        // has not been created on disk yet.
        cwd: process.env.HOME || '/',
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let stdout = '';
    let stderr = '';
    proc.stdout?.on('data', (c) => {
      stdout += c.toString();
    });
    proc.stderr?.on('data', (c) => {
      stderr += c.toString();
    });
    proc.on('close', (code) => {
      if (code === 0) {
        try {
          const j = JSON.parse(stdout) as { Account?: string; Arn?: string; UserId?: string };
          resolve({ ok: true, account: j.Account, arn: j.Arn, userId: j.UserId });
          return;
        } catch {
          resolve({ ok: false, error: 'Invalid JSON from sts get-caller-identity' });
          return;
        }
      }
      const combined = `${stdout}\n${stderr}`;
      const needsLogin =
        /ExpiredToken|expired|not logged in|sso login|Unable to locate credentials|NoCredentialProviders/i.test(
          combined,
        );
      resolve({
        ok: false,
        error: combined.trim().slice(-400) || `exit ${code}`,
        needsLogin,
      });
    });
    proc.on('error', (err) => {
      resolve({ ok: false, error: err.message, needsLogin: true });
    });
  });
}

/**
 * Spawn `aws sso login --no-browser` for the device-code flow under the given
 * env. Returns the detached `ChildProcess`; the caller owns stdout/stderr
 * handling, process tracking, and teardown. Centralizing the spawn here keeps
 * all `aws` CLI invocation in one module (the route file no longer touches
 * `child_process`).
 */
export function spawnAwsSsoLogin(env: NodeJS.ProcessEnv, profile: string): ChildProcess {
  return spawn('aws', ['sso', 'login', '--profile', profile, '--no-browser'], {
    // cwd is the always-existing server-process HOME, NOT env.HOME. The SSO
    // token is written under env.HOME (passed via `env`); cwd is irrelevant to
    // that. Pointing cwd at a per-user env.HOME that has not been created yet
    // would ENOENT-fail the spawn before the device-code URL is ever printed.
    cwd: process.env.HOME || '/',
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });
}
