import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readlinkSync } from 'fs';
import os from 'os';
import path from 'path';
import type { Project } from './types.js';

vi.mock('./config.js', () => ({
  default: { dataDir: '' },
}));

const {
  linkAwsSsoHostCacheIntoSpawnHome,
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

    const written = mergeProjectAwsSpawnEnv(env, project);

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

    mergeProjectAwsSpawnEnv(env, project);

    expect(env.AWS_ACCESS_KEY_ID).toBeUndefined();
    expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(env.AWS_SESSION_TOKEN).toBeUndefined();
    expect(env.AWS_PROFILE).toBeUndefined();
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
    const returned = mergeProjectAwsSpawnEnv(env, project, { configPath: prewritten });
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

  it('linkAwsSsoHostCacheIntoSpawnHome links host SSO cache when per-user cache is empty', () => {
    const hostHome = path.join(tmpDataDir, 'host-creds', 'home');
    const hostCache = path.join(hostHome, '.aws', 'sso', 'cache');
    mkdirSync(hostCache, { recursive: true, mode: 0o700 });
    writeFileSync(path.join(hostCache, 'token.json'), '{"accessToken":"x"}', { mode: 0o600 });

    const userHome = path.join(tmpDataDir, 'per-user-creds', 'u1', 'home');
    mkdirSync(userHome, { recursive: true, mode: 0o700 });
    const env: NodeJS.ProcessEnv = { HOME: userHome };

    linkAwsSsoHostCacheIntoSpawnHome(env, tmpDataDir);

    const userCache = path.join(userHome, '.aws', 'sso', 'cache');
    expect(existsSync(userCache)).toBe(true);
    expect(readlinkSync(userCache)).toBe(hostCache);
  });
});
