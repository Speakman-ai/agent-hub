/**
 * AWS SSO identity probing with HOME-aware fallback.
 *
 * The AWS CLI keys its SSO **token cache** off `$HOME/.aws/sso/cache`.
 * `AWS_CONFIG_FILE` only relocates the profile config, never the token cache.
 * So whichever HOME a spawn runs under decides which cached token it sees.
 *
 * Agent Hub resolves HOME differently depending on who calls `/aws-sso/status`:
 *   - Break-glass `x-api-key` (the documented operator flow): no `authUserId`,
 *     so `buildSpawnEnv({ userId: null })` keeps the shared host HOME
 *     (`<dataDir>/host-creds/home`).
 *   - JWT user: HOME is pinned to that user's per-user HOME
 *     (`<dataDir>/per-user-creds/<userId>/home`).
 *
 * These HOMEs have separate `~/.aws/sso/cache` directories. A status check run
 * under one HOME can report `loggedIn:false` while a valid token sits in
 * another. `checkAwsSsoStatusAcrossHomes` reconciles the common split: probe
 * the caller HOME first, then fall back to the shared host HOME ONLY.
 *
 * SECURITY: never enumerate other users' per-user HOMEs. Probing a different
 * user's cached token could report `loggedIn:true` off their identity, leaking
 * that token's account/ARN and giving the caller a false-positive identity.
 */
import { spawn, type ChildProcess } from 'child_process';
import config, { buildSpawnEnv } from './config.js';
import type { AppConfig } from './types.js';
import { hostCliHomePath } from './host-cli-home.js';

export interface AwsSsoIdentity {
  ok: boolean;
  account?: string;
  arn?: string;
  userId?: string;
  error?: string;
  needsLogin?: boolean;
}

/** Which HOME's token cache produced the reported identity. */
export type AwsHomeSource = 'caller' | 'host' | 'per-user';

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
  /** Configured profile name to probe. */
  profile: string;
  /** Data dir override (tests). Defaults to `config.dataDir`. */
  dataDir?: string;
  /** Identity runner override (tests). Defaults to `runAwsStsIdentity`. */
  run?: RunAwsStsIdentity;
  /** Env builder override (tests). Defaults to `buildSpawnEnv(config, ...)`. */
  buildEnv?: BuildAwsSpawnEnv;
}

/**
 * Probe the caller HOME, then fall back to the shared host HOME ONLY.
 *
 * Resolution:
 *   1. Probe the caller-resolved HOME (cheap, preserves old semantics).
 *      - `homeSource: 'caller'` when the caller has a per-user HOME.
 *      - `homeSource: 'host'` when the caller already used the shared host HOME
 *        (break-glass `x-api-key`, or a per-user HOME that fell back to host).
 *   2. If the caller HOME did not authenticate AND it was a *per-user* HOME,
 *      fall back to the shared host HOME (`hostCliHomePath`) and ONLY that HOME.
 *      A success here is reported as `homeSource: 'host'`.
 *   3. If neither authenticates, return the caller (per-user) result with
 *      `homeSource: 'per-user'` — that is the HOME the caller owns and should
 *      log into.
 *
 * Never probes any other user's per-user HOME.
 */
export async function checkAwsSsoStatusAcrossHomes(
  opts: CheckAwsSsoStatusOpts,
  cfg: AppConfig = config,
): Promise<AwsSsoStatusResult> {
  const dataDir = opts.dataDir ?? cfg.dataDir;
  const run = opts.run ?? runAwsStsIdentity;
  const buildEnv = opts.buildEnv ?? ((userId: string | null) => buildSpawnEnv(cfg, { userId }));
  const hostHome = hostCliHomePath(dataDir);

  const callerEnv = buildEnv(opts.userId);
  callerEnv.AWS_CONFIG_FILE = opts.configPath;
  const callerHome = (callerEnv.HOME ?? '').trim();
  // When there is no owning user, or the per-user HOME resolution fell back to
  // the shared host HOME, the caller IS the host — there is no second HOME to
  // try and a success/failure is attributable to the host token cache.
  const callerIsHost = !opts.userId || callerHome === hostHome;

  const primary = await run(callerEnv, opts.profile);
  if (primary.ok) {
    return { ...primary, homeSource: callerIsHost ? 'host' : 'caller' };
  }
  if (callerIsHost) {
    return { ...primary, homeSource: 'host' };
  }

  // Caller was a per-user HOME and did not authenticate. Fall back to ONLY the
  // shared host/operator HOME — never another user's per-user tree.
  const hostEnv = buildEnv(null);
  hostEnv.HOME = hostHome;
  hostEnv.AWS_CONFIG_FILE = opts.configPath;
  const fallback = await run(hostEnv, opts.profile);
  if (fallback.ok) {
    return { ...fallback, homeSource: 'host' };
  }

  // Neither HOME authenticated. Surface the caller (per-user) result: that is
  // the HOME the caller owns and the one they should log into.
  return { ...primary, homeSource: 'per-user' };
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
