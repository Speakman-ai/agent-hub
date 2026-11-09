import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  mkdtempSync,
  readdirSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  existsSync,
  lstatSync,
  symlinkSync,
} from 'fs';
import os from 'os';
import path from 'path';
import type { Project } from './types.js';

vi.mock('./config.js', () => ({
  default: { dataDir: '' },
}));

const fsControl = vi.hoisted(() => ({
  unlinkError: null as NodeJS.ErrnoException | null,
  rmError: null as NodeJS.ErrnoException | null,
}));
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    rmSync: (p: import('fs').PathLike, o?: import('fs').RmOptions) => {
      if (fsControl.rmError) throw fsControl.rmError;
      actual.rmSync(p, o);
    },
    unlinkSync: (p: import('fs').PathLike) => {
      if (fsControl.unlinkError) throw fsControl.unlinkError;
      actual.unlinkSync(p);
    },
  };
});

const {
  getProjectAwsDefaultProfile,
  getProjectAwsMonitoringProfile,
  ensurePrivateAwsSsoCache,
  mergeProjectAwsSpawnEnv,
  projectHasAwsSsoProfiles,
  scrubAwsCredentialEnv,
} = await import('./project-aws-spawn.js');
const configMod = await import('./config.js');

describe('project-aws-spawn', () => {
  let tmpDataDir: string;

  beforeEach(() => {
    tmpDataDir = mkdtempSync(path.join(os.tmpdir(), 'project-aws-spawn-'));
    (configMod.default as { dataDir: string }).dataDir = tmpDataDir;
  });

  afterEach(() => {
    rmSync(tmpDataDir, { recursive: true, force: true });
  });

  it('projectHasAwsSsoProfiles is false when map is empty', () => {
    const project = { id: 'p1', awsSsoProfiles: {} } as unknown as Project;
    expect(projectHasAwsSsoProfiles(project)).toBe(false);
  });

  it('mergeProjectAwsSpawnEnv sets AWS_CONFIG_FILE and profile list', () => {
    const project = {
      id: 'agent-hub',
      awsSsoProfiles: {
        dev: {
          sso_start_url: 'https://example.awsapps.com/start',
          sso_region: 'us-east-1',
          sso_account_id: '111111111111',
          sso_role_name: 'Admin',
          region: 'us-east-1',
        },
      },
    } as unknown as Project;
    const env: NodeJS.ProcessEnv = { HOME: path.join(tmpDataDir, 'user-home') };
    mkdirSync(env.HOME!, { recursive: true, mode: 0o700 });

    const written = mergeProjectAwsSpawnEnv(env, project, { ownerUserId: null });

    expect(written).toContain(path.join('project-aws-config', 'agent-hub', 'config'));
    expect(env.AWS_CONFIG_FILE).toBe(written);
    expect(env.AWS_SHARED_CREDENTIALS_FILE).toContain(
      path.join('project-aws-config', 'agent-hub', 'credentials'),
    );
    expect(env.AGENT_HUB_AWS_PROFILE_NAMES).toBe('dev');
  });

  it('mergeProjectAwsSpawnEnv scrubs inherited AWS credential env vars', () => {
    const project = {
      id: 'agent-hub',
      awsSsoProfiles: {
        staticdev: {
          type: 'static',
          aws_access_key_id: 'AKIATESTKEY',
          aws_secret_access_key: 'secret-test-key',
          region: 'us-east-1',
        },
      },
    } as unknown as Project;
    const env: NodeJS.ProcessEnv = {
      AWS_ACCESS_KEY_ID: 'inherited-key',
      AWS_SECRET_ACCESS_KEY: 'inherited-secret',
      AWS_SESSION_TOKEN: 'inherited-token',
      AWS_PROFILE: 'other-project',
    };

    mergeProjectAwsSpawnEnv(env, project, { ownerUserId: null });

    expect(env.AWS_ACCESS_KEY_ID).toBeUndefined();
    expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(env.AWS_SESSION_TOKEN).toBeUndefined();
    // The inherited profile named a profile from another project's config; the
    // spawn gets this project's own default instead.
    expect(env.AWS_PROFILE).toBe('staticdev');
    expect(env.AWS_CONFIG_FILE).toContain(path.join('project-aws-config', 'agent-hub', 'config'));
    expect(env.AWS_SHARED_CREDENTIALS_FILE).toContain(
      path.join('project-aws-config', 'agent-hub', 'credentials'),
    );
  });

  it('mergeProjectAwsSpawnEnv reuses a pre-written config path', () => {
    const project = {
      id: 'agent-hub',
      awsSsoProfiles: {
        dev: {
          sso_start_url: 'https://example.awsapps.com/start',
          sso_region: 'us-east-1',
          sso_account_id: '111111111111',
          sso_role_name: 'Admin',
          region: 'us-east-1',
        },
      },
    } as unknown as Project;
    const prewritten = path.join(tmpDataDir, 'existing-config');
    const env: NodeJS.ProcessEnv = {};
    const returned = mergeProjectAwsSpawnEnv(env, project, {
      ownerUserId: null,
      configPath: prewritten,
    });
    expect(returned).toContain(path.join('project-aws-config', 'agent-hub', 'config'));
    expect(env.AWS_CONFIG_FILE).toBe(returned);
  });

  it('mergeProjectAwsSpawnEnv reuses pre-written config and credentials paths together', () => {
    const project = {
      id: 'agent-hub',
      awsSsoProfiles: {
        dev: {
          sso_start_url: 'https://example.awsapps.com/start',
          sso_region: 'us-east-1',
          sso_account_id: '111111111111',
          sso_role_name: 'Admin',
          region: 'us-east-1',
        },
      },
    } as unknown as Project;
    const prewrittenConfig = path.join(tmpDataDir, 'existing-config');
    const prewrittenCredentials = path.join(tmpDataDir, 'existing-credentials');
    const env: NodeJS.ProcessEnv = {};
    const returned = mergeProjectAwsSpawnEnv(env, project, {
      ownerUserId: null,
      configPath: prewrittenConfig,
      credentialsPath: prewrittenCredentials,
    });
    expect(returned).toBe(prewrittenConfig);
    expect(env.AWS_CONFIG_FILE).toBe(prewrittenConfig);
    expect(env.AWS_SHARED_CREDENTIALS_FILE).toBe(prewrittenCredentials);
  });

  it('scrubAwsCredentialEnv clears direct credentials that override profile files', () => {
    const env: NodeJS.ProcessEnv = {
      AWS_ACCESS_KEY_ID: 'key',
      AWS_SECRET_ACCESS_KEY: 'secret',
      AWS_SESSION_TOKEN: 'token',
      AWS_SECURITY_TOKEN: 'legacy-token',
      AWS_PROFILE: 'other',
      AWS_DEFAULT_PROFILE: 'default-other',
    };
    scrubAwsCredentialEnv(env);
    expect(env).toEqual({});
  });

  describe('ensurePrivateAwsSsoCache', () => {
    afterEach(() => {
      fsControl.unlinkError = null;
      fsControl.rmError = null;
    });

    const SSO_PROJECT = {
      id: 'agent-hub',
      awsSsoProfiles: {
        dev: {
          sso_start_url: 'https://example.awsapps.com/start',
          sso_region: 'us-east-1',
          sso_account_id: '111111111111',
          sso_role_name: 'Admin',
          region: 'us-east-1',
        },
      },
    } as unknown as Project;

    /** Role credentials the CLI derived from the operator's token while linked. */
    function seedDerivedRoleCreds(home: string): string {
      const cliCache = path.join(home, '.aws', 'cli', 'cache');
      mkdirSync(cliCache, { recursive: true, mode: 0o700 });
      writeFileSync(
        path.join(cliCache, 'abc123.json'),
        '{"Credentials":{"AccessKeyId":"ASIAOPERATOR"},"ProviderType":"sso"}',
      );
      return cliCache;
    }

    function seedHostCache(): string {
      const hostCache = path.join(tmpDataDir, 'host-creds', 'home', '.aws', 'sso', 'cache');
      mkdirSync(hostCache, { recursive: true, mode: 0o700 });
      writeFileSync(path.join(hostCache, 'token.json'), '{"accessToken":"operator"}');
      return hostCache;
    }

    function userHome(id: string): string {
      const home = path.join(tmpDataDir, 'per-user-creds', id, 'home');
      mkdirSync(path.join(home, '.aws', 'sso'), { recursive: true, mode: 0o700 });
      return home;
    }

    function linkToHost(home: string, hostCache: string): string {
      const userCache = path.join(home, '.aws', 'sso', 'cache');
      symlinkSync(hostCache, userCache, 'dir');
      return userCache;
    }

    it('does not hand a user the host SSO token when their own cache is empty', () => {
      // Regression: spawns used to symlink the host cache into an empty
      // per-user HOME, so every user ran as the operator's SSO login.
      seedHostCache();
      const home = userHome('u1');
      expect(ensurePrivateAwsSsoCache({ HOME: home }, 'u1', tmpDataDir)).toEqual({
        ok: true,
        detached: false,
      });
      expect(existsSync(path.join(home, '.aws', 'sso', 'cache'))).toBe(false);
    });

    it('removes an existing link to the host cache and leaves the host token intact', () => {
      const hostCache = seedHostCache();
      const home = userHome('u1');
      const userCache = linkToHost(home, hostCache);

      expect(ensurePrivateAwsSsoCache({ HOME: home }, 'u1', tmpDataDir)).toEqual({
        ok: true,
        detached: true,
      });
      expect(existsSync(userCache)).toBe(false);
      expect(existsSync(path.join(hostCache, 'token.json'))).toBe(true);
    });

    it("keeps a user's own cache directory", () => {
      seedHostCache();
      const home = userHome('u1');
      const userCache = path.join(home, '.aws', 'sso', 'cache');
      mkdirSync(userCache);
      writeFileSync(path.join(userCache, 'mine.json'), '{}');

      expect(ensurePrivateAwsSsoCache({ HOME: home }, 'u1', tmpDataDir).ok).toBe(true);
      expect(lstatSync(userCache).isDirectory()).toBe(true);
      expect(existsSync(path.join(userCache, 'mine.json'))).toBe(true);
    });

    it('passes for the host itself (no owning user)', () => {
      seedHostCache();
      const hostHome = path.join(tmpDataDir, 'host-creds', 'home');
      expect(ensurePrivateAwsSsoCache({ HOME: hostHome }, null, tmpDataDir).ok).toBe(true);
    });

    it("fails closed when an owning user's HOME resolved to the host HOME", () => {
      seedHostCache();
      const hostHome = path.join(tmpDataDir, 'host-creds', 'home');
      const res = ensurePrivateAwsSsoCache({ HOME: hostHome }, 'u1', tmpDataDir);
      expect(res.ok).toBe(false);
    });

    it('fails closed when the shared link cannot be removed', () => {
      const hostCache = seedHostCache();
      const home = userHome('u1');
      const userCache = linkToHost(home, hostCache);
      fsControl.unlinkError = Object.assign(new Error('permission denied'), { code: 'EACCES' });

      const res = ensurePrivateAwsSsoCache({ HOME: home }, 'u1', tmpDataDir);
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.reason).toMatch(/EACCES/);
      expect(lstatSync(userCache).isSymbolicLink()).toBe(true);
    });

    it('clears role credentials derived from the shared token before removing the link', () => {
      // Regression: the CLI reuses ~/.aws/cli/cache role credentials until they
      // expire without rereading the SSO token, so removing only the link kept
      // the user running as the operator's principal.
      const hostCache = seedHostCache();
      const home = userHome('u1');
      linkToHost(home, hostCache);
      const cliCache = seedDerivedRoleCreds(home);

      expect(ensurePrivateAwsSsoCache({ HOME: home }, 'u1', tmpDataDir)).toEqual({
        ok: true,
        detached: true,
      });
      expect(existsSync(cliCache)).toBe(false);
      expect(existsSync(path.join(home, '.aws', 'sso', 'cache'))).toBe(false);
      expect(readdirSync(hostCache)).toEqual(['token.json']);
    });

    it('fails closed and keeps the link when derived credentials cannot be cleared', () => {
      const hostCache = seedHostCache();
      const home = userHome('u1');
      const userCache = linkToHost(home, hostCache);
      seedDerivedRoleCreds(home);
      fsControl.rmError = Object.assign(new Error('permission denied'), { code: 'EACCES' });

      const res = ensurePrivateAwsSsoCache({ HOME: home }, 'u1', tmpDataDir);
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.reason).toMatch(/cached role credentials/);
      // The link stays, so the next attempt still sees the taint and retries.
      expect(lstatSync(userCache).isSymbolicLink()).toBe(true);
      fsControl.rmError = null;
      expect(ensurePrivateAwsSsoCache({ HOME: home }, 'u1', tmpDataDir).ok).toBe(true);
    });

    it("leaves a user's own derived credentials alone when nothing was shared", () => {
      seedHostCache();
      const home = userHome('u1');
      const cliCache = seedDerivedRoleCreds(home);
      expect(ensurePrivateAwsSsoCache({ HOME: home }, 'u1', tmpDataDir).ok).toBe(true);
      expect(existsSync(path.join(cliCache, 'abc123.json'))).toBe(true);
    });

    it("fails closed when the user's whole ~/.aws resolves to the host's", () => {
      seedHostCache();
      const home = path.join(tmpDataDir, 'per-user-creds', 'u1', 'home');
      mkdirSync(home, { recursive: true });
      symlinkSync(
        path.join(tmpDataDir, 'host-creds', 'home', '.aws'),
        path.join(home, '.aws'),
        'dir',
      );
      expect(ensurePrivateAwsSsoCache({ HOME: home }, 'u1', tmpDataDir).ok).toBe(false);
    });

    function seedHostCliCache(): string {
      const hostCli = path.join(tmpDataDir, 'host-creds', 'home', '.aws', 'cli');
      mkdirSync(path.join(hostCli, 'cache'), { recursive: true, mode: 0o700 });
      writeFileSync(path.join(hostCli, 'cache', 'host-role.json'), '{"ProviderType":"sso"}');
      return hostCli;
    }

    it("never deletes the host's role-credential cache through a linked ~/.aws/cli", () => {
      // Regression: with the legacy SSO link present and ~/.aws/cli linked to
      // the host's, the recursive cleanup followed the link into the host cache.
      const hostCache = seedHostCache();
      const hostCli = seedHostCliCache();
      const home = userHome('u1');
      const userCache = linkToHost(home, hostCache);
      symlinkSync(hostCli, path.join(home, '.aws', 'cli'), 'dir');

      const res = ensurePrivateAwsSsoCache({ HOME: home }, 'u1', tmpDataDir);
      expect(res.ok).toBe(false);
      expect(existsSync(path.join(hostCli, 'cache', 'host-role.json'))).toBe(true);
      expect(lstatSync(userCache).isSymbolicLink()).toBe(true);
    });

    it("never deletes the host's role-credential cache through a linked ~/.aws/cli/cache", () => {
      const hostCache = seedHostCache();
      const hostCli = seedHostCliCache();
      const home = userHome('u1');
      linkToHost(home, hostCache);
      mkdirSync(path.join(home, '.aws', 'cli'));
      symlinkSync(path.join(hostCli, 'cache'), path.join(home, '.aws', 'cli', 'cache'), 'dir');

      expect(ensurePrivateAwsSsoCache({ HOME: home }, 'u1', tmpDataDir).ok).toBe(false);
      expect(existsSync(path.join(hostCli, 'cache', 'host-role.json'))).toBe(true);
    });

    it('fails closed when ~/.aws/sso is a link', () => {
      seedHostCache();
      const home = path.join(tmpDataDir, 'per-user-creds', 'u1', 'home');
      mkdirSync(path.join(home, '.aws'), { recursive: true });
      symlinkSync(
        path.join(tmpDataDir, 'host-creds', 'home', '.aws', 'sso'),
        path.join(home, '.aws', 'sso'),
        'dir',
      );
      expect(ensurePrivateAwsSsoCache({ HOME: home }, 'u1', tmpDataDir).ok).toBe(false);
    });

    it('fails closed when the SSO cache links somewhere other than the host cache', () => {
      const elsewhere = path.join(tmpDataDir, 'elsewhere');
      mkdirSync(elsewhere);
      const home = userHome('u1');
      symlinkSync(elsewhere, path.join(home, '.aws', 'sso', 'cache'), 'dir');
      expect(ensurePrivateAwsSsoCache({ HOME: home }, 'u1', tmpDataDir).ok).toBe(false);
    });

    it('fails closed when the per-user HOME itself resolves inside the host HOME', () => {
      seedHostCache();
      const home = path.join(tmpDataDir, 'per-user-creds', 'u1', 'home');
      mkdirSync(path.dirname(home), { recursive: true });
      symlinkSync(path.join(tmpDataDir, 'host-creds', 'home'), home, 'dir');
      expect(ensurePrivateAwsSsoCache({ HOME: home }, 'u1', tmpDataDir).ok).toBe(false);
    });

    it('mergeProjectAwsSpawnEnv strips AWS from a spawn whose shared link cannot be removed', () => {
      const hostCache = seedHostCache();
      const home = userHome('u1');
      linkToHost(home, hostCache);
      fsControl.unlinkError = Object.assign(new Error('permission denied'), { code: 'EACCES' });
      const env: NodeJS.ProcessEnv = { HOME: home };

      expect(mergeProjectAwsSpawnEnv(env, SSO_PROJECT, { ownerUserId: 'u1' })).toBeNull();
      expect(env.AWS_CONFIG_FILE).toBe(os.devNull);
      expect(env.AWS_SHARED_CREDENTIALS_FILE).toBe(os.devNull);
      expect(env.AWS_PROFILE).toBeUndefined();
      expect(env.AGENT_HUB_AWS_PROFILE_NAMES).toBeUndefined();
      expect(env.AGENT_HUB_AWS_DISABLED_REASON).toMatch(/EACCES/);
    });

    it("mergeProjectAwsSpawnEnv strips AWS when an owner's HOME fell back to the host HOME", () => {
      seedHostCache();
      const env: NodeJS.ProcessEnv = { HOME: path.join(tmpDataDir, 'host-creds', 'home') };
      expect(mergeProjectAwsSpawnEnv(env, SSO_PROJECT, { ownerUserId: 'u1' })).toBeNull();
      expect(env.AWS_CONFIG_FILE).toBe(os.devNull);
    });

    it('mergeProjectAwsSpawnEnv keeps AWS for a private cache', () => {
      const home = userHome('u1');
      const env: NodeJS.ProcessEnv = { HOME: home };
      expect(mergeProjectAwsSpawnEnv(env, SSO_PROJECT, { ownerUserId: 'u1' })).toBeTruthy();
      expect(env.AWS_CONFIG_FILE).toContain('project-aws-config');
      expect(env.AGENT_HUB_AWS_PROFILE_NAMES).toBe('dev');
    });
  });
});

describe('project-aws default profile export', () => {
  let tmpDataDir: string;

  beforeEach(() => {
    tmpDataDir = mkdtempSync(path.join(os.tmpdir(), 'project-aws-default-'));
    (configMod.default as { dataDir: string }).dataDir = tmpDataDir;
  });

  afterEach(() => {
    rmSync(tmpDataDir, { recursive: true, force: true });
  });

  const SSO = {
    sso_start_url: 'https://example.awsapps.com/start',
    sso_region: 'us-east-1',
    sso_account_id: '111111111111',
    sso_role_name: 'Admin',
    region: 'us-east-1',
  };

  it('exports the designated profile as AWS_PROFILE', () => {
    const project = {
      id: 'agent-hub',
      awsSsoProfiles: { dev: SSO, prod: SSO },
      awsDefaultProfile: 'prod',
    } as unknown as Project;
    const env: NodeJS.ProcessEnv = {};

    mergeProjectAwsSpawnEnv(env, project, { ownerUserId: null });

    expect(env.AWS_PROFILE).toBe('prod');
  });

  it('leaves AWS_PROFILE unset for a multi-profile project with no designation', () => {
    const project = {
      id: 'agent-hub',
      awsSsoProfiles: { dev: SSO, prod: SSO },
    } as unknown as Project;
    const env: NodeJS.ProcessEnv = { AWS_PROFILE: 'inherited' };

    mergeProjectAwsSpawnEnv(env, project, { ownerUserId: null });

    expect(env.AWS_PROFILE).toBeUndefined();
  });

  it('ignores a designation naming a profile that no longer exists', () => {
    const project = {
      id: 'agent-hub',
      awsSsoProfiles: { dev: SSO, prod: SSO },
      awsDefaultProfile: 'deleted',
    } as unknown as Project;
    const env: NodeJS.ProcessEnv = {};

    mergeProjectAwsSpawnEnv(env, project, { ownerUserId: null });

    expect(env.AWS_PROFILE).toBeUndefined();
  });

  it('getProjectAwsDefaultProfile trims and normalizes blanks to null', () => {
    expect(
      getProjectAwsDefaultProfile({ id: 'p', awsDefaultProfile: ' prod ' } as unknown as Project),
    ).toBe('prod');
    expect(
      getProjectAwsDefaultProfile({ id: 'p', awsDefaultProfile: '  ' } as unknown as Project),
    ).toBeNull();
    expect(getProjectAwsDefaultProfile({ id: 'p' } as unknown as Project)).toBeNull();
  });

  it('getProjectAwsMonitoringProfile trims and normalizes blanks to null', () => {
    expect(
      getProjectAwsMonitoringProfile({
        id: 'p',
        awsMonitoringProfile: ' monitoring ',
      } as unknown as Project),
    ).toBe('monitoring');
    expect(
      getProjectAwsMonitoringProfile({ id: 'p', awsMonitoringProfile: '  ' } as unknown as Project),
    ).toBeNull();
    expect(getProjectAwsMonitoringProfile({ id: 'p' } as unknown as Project)).toBeNull();
  });

  // Background collection is a separate designation: it must never leak into
  // the AWS_PROFILE a human's un-flagged `aws` command resolves to.
  it('does not export the monitoring profile as AWS_PROFILE', () => {
    const project = {
      id: 'agent-hub',
      awsSsoProfiles: { dev: SSO, prod: SSO },
      awsMonitoringProfile: 'prod',
    } as unknown as Project;
    const env: NodeJS.ProcessEnv = {};

    mergeProjectAwsSpawnEnv(env, project, { ownerUserId: null });

    expect(env.AWS_PROFILE).toBeUndefined();
  });
});
