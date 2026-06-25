import { describe, it, expect, vi } from 'vitest';
import { checkAwsSsoStatusAcrossHomes, type AwsSsoIdentity } from './aws-sso-identity.js';
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

describe('checkAwsSsoStatusAcrossHomes', () => {
  it('break-glass (userId null) authenticates under host HOME → homeSource host, single probe', async () => {
    const { run, probed } = runnerFor([HOST_HOME]);
    const res = await checkAwsSsoStatusAcrossHomes({
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
    const res = await checkAwsSsoStatusAcrossHomes({
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

  it('JWT user empty per-user HOME but token in host HOME → falls back, homeSource host', async () => {
    const { run, probed } = runnerFor([HOST_HOME]);
    const res = await checkAwsSsoStatusAcrossHomes({
      userId: USER_A,
      configPath: '/cfg',
      profile: 'agenthub',
      dataDir: DATA_DIR,
      run,
      buildEnv: fakeBuildEnv,
    });
    expect(res.ok).toBe(true);
    expect(res.homeSource).toBe('host');
    // Caller HOME probed first, then host HOME.
    expect(probed).toEqual([HOME_A, HOST_HOME]);
  });

  it('neither caller nor host HOME authenticates → loggedIn false, homeSource per-user', async () => {
    const { run, probed } = runnerFor([]);
    const res = await checkAwsSsoStatusAcrossHomes({
      userId: USER_A,
      configPath: '/cfg',
      profile: 'agenthub',
      dataDir: DATA_DIR,
      run,
      buildEnv: fakeBuildEnv,
    });
    expect(res.ok).toBe(false);
    expect(res.needsLogin).toBe(true);
    expect(res.homeSource).toBe('per-user');
    expect(probed).toEqual([HOME_A, HOST_HOME]);
  });

  it('SECURITY: never probes another user’s per-user HOME even if it holds a valid token', async () => {
    // Only USER_B has a valid token. USER_A queries status. The function must
    // NOT discover B's token (that would leak B's account/ARN as A's identity).
    const { run, probed } = runnerFor([HOME_B]);
    const res = await checkAwsSsoStatusAcrossHomes({
      userId: USER_A,
      configPath: '/cfg',
      profile: 'agenthub',
      dataDir: DATA_DIR,
      run,
      buildEnv: fakeBuildEnv,
    });
    expect(res.ok).toBe(false);
    expect(res.homeSource).toBe('per-user');
    // Only A's HOME and the shared host HOME were ever probed.
    expect(probed).toEqual([HOME_A, HOST_HOME]);
    expect(probed).not.toContain(HOME_B);
  });

  it('break-glass failure does not double-probe and reports homeSource host', async () => {
    const { run, probed } = runnerFor([]);
    const res = await checkAwsSsoStatusAcrossHomes({
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

  it('per-user HOME that resolves to the host HOME is treated as host (no second probe)', async () => {
    // Simulate buildSpawnEnv falling back to the host HOME for a userId (FS
    // error path): the env builder returns HOST_HOME even with a userId.
    const fallbackBuildEnv = (_userId: string | null): NodeJS.ProcessEnv => ({ HOME: HOST_HOME });
    const { run, probed } = runnerFor([]);
    const res = await checkAwsSsoStatusAcrossHomes({
      userId: USER_A,
      configPath: '/cfg',
      profile: 'agenthub',
      dataDir: DATA_DIR,
      run,
      buildEnv: fallbackBuildEnv,
    });
    expect(res.homeSource).toBe('host');
    expect(probed).toEqual([HOST_HOME]);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('threads AWS_CONFIG_FILE into the probe env', async () => {
    const seen: Array<string | undefined> = [];
    const run = vi.fn(async (env: NodeJS.ProcessEnv): Promise<AwsSsoIdentity> => {
      seen.push(env.AWS_CONFIG_FILE);
      return { ...FAIL };
    });
    await checkAwsSsoStatusAcrossHomes({
      userId: USER_A,
      configPath: '/path/to/aws.config',
      profile: 'agenthub',
      dataDir: DATA_DIR,
      run,
      buildEnv: fakeBuildEnv,
    });
    expect(seen).toEqual(['/path/to/aws.config', '/path/to/aws.config']);
  });

  it('threads AWS_SHARED_CREDENTIALS_FILE into every probe env when provided', async () => {
    const seen: Array<string | undefined> = [];
    const run = vi.fn(async (env: NodeJS.ProcessEnv): Promise<AwsSsoIdentity> => {
      seen.push(env.AWS_SHARED_CREDENTIALS_FILE);
      return { ...FAIL };
    });
    await checkAwsSsoStatusAcrossHomes({
      userId: USER_A,
      configPath: '/path/to/aws.config',
      credentialsPath: '/path/to/aws.credentials',
      profile: 'agenthub',
      dataDir: DATA_DIR,
      run,
      buildEnv: fakeBuildEnv,
    });
    expect(seen).toEqual(['/path/to/aws.credentials', '/path/to/aws.credentials']);
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
    await checkAwsSsoStatusAcrossHomes({
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
