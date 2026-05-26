import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readlinkSync } from 'fs';
import os from 'os';
import path from 'path';
import type { Project } from './types.js';

vi.mock('./config.js', () => ({
  default: { dataDir: '' },
}));

const { ensureAwsSsoCacheInSpawnHome, mergeProjectAwsSpawnEnv, projectHasAwsSsoProfiles } =
  await import('./project-aws-spawn.js');
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

    mergeProjectAwsSpawnEnv(env, project);

    expect(env.AWS_CONFIG_FILE).toContain(path.join('project-aws-config', 'agent-hub', 'config'));
    expect(env.AGENT_HUB_AWS_PROFILE_NAMES).toBe('dev');
  });

  it('ensureAwsSsoCacheInSpawnHome links host SSO cache when per-user cache is empty', () => {
    const hostHome = path.join(tmpDataDir, 'host-creds', 'home');
    const hostCache = path.join(hostHome, '.aws', 'sso', 'cache');
    mkdirSync(hostCache, { recursive: true, mode: 0o700 });
    writeFileSync(path.join(hostCache, 'token.json'), '{"accessToken":"x"}', { mode: 0o600 });

    const userHome = path.join(tmpDataDir, 'per-user-creds', 'u1', 'home');
    mkdirSync(userHome, { recursive: true, mode: 0o700 });
    const env: NodeJS.ProcessEnv = { HOME: userHome };

    ensureAwsSsoCacheInSpawnHome(env, tmpDataDir);

    const userCache = path.join(userHome, '.aws', 'sso', 'cache');
    expect(existsSync(userCache)).toBe(true);
    expect(readlinkSync(userCache)).toBe(hostCache);
  });
});
