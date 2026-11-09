import { describe, it, expect, vi } from 'vitest';
import { checkAwsSsoStatusForCaller, type AwsSsoIdentity } from './aws-sso-identity.js';
import { hostCliHomePath } from './host-cli-home.js';
import { perUserHomePath } from './per-user-home.js';

const DATA_DIR = '/tmp/aws-sso-identity-test';
const HOST_HOME = hostCliHomePath(DATA_DIR);
const USER_A = 'user-aaaa';
const USER_B = 'user-bbbb';
const HOME_A = perUserHomePath(USER_A, DATA_DIR);
const HOME_B = perUserHomePath(USER_B, DATA_DIR);

const OK: AwsSsoIdentity = {
  ok: true,
  account: '111122223333',
  arn: 'arn:aws:sts::111122223333:assumed-role/Dev/x',
  userId: 'AID:dev',
};
const FAIL: AwsSsoIdentity = { ok: false, error: 'ExpiredToken', needsLogin: true };

/** Build a fake env-builder that pins HOME per resolved userId, like buildSpawnEnv. */
function fakeBuildEnv(userId: string | null): NodeJS.ProcessEnv {
  if (!userId) return { HOME: HOST_HOME };
  return { HOME: perUserHomePath(userId, DATA_DIR) };
}

/**
 * Identity runner that authenticates only for the HOMEs listed in `goodHomes`.
 * Records every HOME it was asked to probe so tests can assert which token
 * caches were (and were NOT) touched.
 */
function runnerFor(goodHomes: string[]) {
  const probed: string[] = [];
  const run = vi.fn(async (env: NodeJS.ProcessEnv): Promise<AwsSsoIdentity> => {
    const home = (env.HOME ?? '').trim();
    probed.push(home);
    return goodHomes.includes(home) ? { ...OK } : { ...FAIL };
  });
  return { run, probed };
}

describe('checkAwsSsoStatusForCaller', () => {
  it('break-glass (userId null) authenticates under host HOME → homeSource host, single probe', async () => {
    const { run, probed } = runnerFor([HOST_HOME]);
    const res = await checkAwsSsoStatusForCaller({
      userId: null,
      configPath: '/cfg',
      profile: 'agenthub',
      dataDir: DATA_DIR,
      run,
      buildEnv: fakeBuildEnv,
    });
    expect(res.ok).toBe(true);
    expect(res.account).toBe('111122223333');
    expect(res.homeSource).toBe('host');
    expect(probed).toEqual([HOST_HOME]);
    // No fallback probe when the caller already used the host HOME.
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('JWT user authenticates under their own per-user HOME → homeSource caller, single probe', async () => {
    const { run, probed } = runnerFor([HOME_A]);
    const res = await checkAwsSsoStatusForCaller({
      userId: USER_A,
      configPath: '/cfg',
      profile: 'agenthub',
      dataDir: DATA_DIR,
      run,
      buildEnv: fakeBuildEnv,
    });
    expect(res.ok).toBe(true);
    expect(res.homeSource).toBe('caller');
    expect(probed).toEqual([HOME_A]);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('user with no token of their own stays logged out even when the host HOME has one', async () => {
    // Regression: the probe used to fall back to the shared host HOME, so any
    // user reported the operator's SSO identity as their own login.
    const { run, probed } = runnerFor([HOST_HOME]);
    const res = await checkAwsSsoStatusForCaller({
      userId: USER_A,
      configPath: '/cfg',
      profile: 'agenthub',
      dataDir: DATA_DIR,
      run,
      buildEnv: fakeBuildEnv,
    });
    expect(res.ok).toBe(false);
    expect(res.needsLogin).toBe(true);
    expect(res.homeSource).toBe('caller');
    expect(probed).toEqual([HOME_A]);
  });

  it('never probes another user’s per-user HOME even if it holds a valid token', async () => {
    const { run, probed } = runnerFor([HOME_B]);
    const res = await checkAwsSsoStatusForCaller({
      userId: USER_A,
      configPath: '/cfg',
      profile: 'agenthub',
      dataDir: DATA_DIR,
      run,
      buildEnv: fakeBuildEnv,
    });
    expect(res.ok).toBe(false);
    expect(probed).toEqual([HOME_A]);
  });

  it('break-glass failure does not double-probe and reports homeSource host', async () => {
    const { run, probed } = runnerFor([]);
    const res = await checkAwsSsoStatusForCaller({
      userId: null,
      configPath: '/cfg',
      profile: 'agenthub',
      dataDir: DATA_DIR,
      run,
      buildEnv: fakeBuildEnv,
    });
    expect(res.ok).toBe(false);
    expect(res.homeSource).toBe('host');
    expect(probed).toEqual([HOST_HOME]);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('fails closed when an owning user’s HOME resolves to the host HOME, even with a valid host token', async () => {
    // buildSpawnEnv falls back to the host HOME when the per-user HOME cannot
    // be created. The operator's token must not be reported as the user's.
    const fallbackBuildEnv = (_userId: string | null): NodeJS.ProcessEnv => ({ HOME: HOST_HOME });
    const { run, probed } = runnerFor([HOST_HOME]);
    const res = await checkAwsSsoStatusForCaller({
      userId: USER_A,
      configPath: '/cfg',
      profile: 'agenthub',
      dataDir: DATA_DIR,
      run,
      buildEnv: fallbackBuildEnv,
    });
    expect(res.ok).toBe(false);
    expect(res.account).toBeUndefined();
    expect(res.homeSource).toBe('caller');
    expect(res.error).toMatch(/per-user HOME is unavailable/);
    expect(probed).toEqual([]);
    expect(run).not.toHaveBeenCalled();
  });

  it('threads AWS_CONFIG_FILE into the probe env', async () => {
    const seen: Array<string | undefined> = [];
    const run = vi.fn(async (env: NodeJS.ProcessEnv): Promise<AwsSsoIdentity> => {
      seen.push(env.AWS_CONFIG_FILE);
      return { ...FAIL };
    });
    await checkAwsSsoStatusForCaller({
      userId: USER_A,
      configPath: '/path/to/aws.config',
      profile: 'agenthub',
      dataDir: DATA_DIR,
      run,
      buildEnv: fakeBuildEnv,
    });
    expect(seen).toEqual(['/path/to/aws.config']);
  });

  it('threads AWS_SHARED_CREDENTIALS_FILE into the probe env when provided', async () => {
    const seen: Array<string | undefined> = [];
    const run = vi.fn(async (env: NodeJS.ProcessEnv): Promise<AwsSsoIdentity> => {
      seen.push(env.AWS_SHARED_CREDENTIALS_FILE);
      return { ...FAIL };
    });
    await checkAwsSsoStatusForCaller({
      userId: USER_A,
      configPath: '/path/to/aws.config',
      credentialsPath: '/path/to/aws.credentials',
      profile: 'agenthub',
      dataDir: DATA_DIR,
      run,
      buildEnv: fakeBuildEnv,
    });
    expect(seen).toEqual(['/path/to/aws.credentials']);
  });

  it('scrubs direct AWS credential env vars that would override the profile files', async () => {
    const seen: NodeJS.ProcessEnv[] = [];
    const buildEnv = (_userId: string | null): NodeJS.ProcessEnv => ({
      HOME: HOME_A,
      AWS_ACCESS_KEY_ID: 'inherited-key',
      AWS_SECRET_ACCESS_KEY: 'inherited-secret',
      AWS_SESSION_TOKEN: 'inherited-token',
      AWS_PROFILE: 'other-project',
    });
    const run = vi.fn(async (env: NodeJS.ProcessEnv): Promise<AwsSsoIdentity> => {
      seen.push({ ...env });
      return { ...FAIL };
    });
    await checkAwsSsoStatusForCaller({
      userId: USER_A,
      configPath: '/path/to/aws.config',
      credentialsPath: '/path/to/aws.credentials',
      profile: 'agenthub',
      dataDir: DATA_DIR,
      run,
      buildEnv,
    });
    expect(seen[0].AWS_ACCESS_KEY_ID).toBeUndefined();
    expect(seen[0].AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(seen[0].AWS_SESSION_TOKEN).toBeUndefined();
    expect(seen[0].AWS_PROFILE).toBeUndefined();
    expect(seen[0].AWS_CONFIG_FILE).toBe('/path/to/aws.config');
    expect(seen[0].AWS_SHARED_CREDENTIALS_FILE).toBe('/path/to/aws.credentials');
  });
});
