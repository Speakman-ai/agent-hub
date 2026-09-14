import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
import type { Project, SessionRow } from '../types.js';

vi.mock('../config.js', () => ({
  default: { dataDir: '' },
  resolveAgentHubApiBaseForSpawn: vi.fn(() => 'https://hub.example.test/prefix'),
  buildSpawnEnv: vi.fn((_config, opts) => ({
    HOME: opts.userId ? `/users/${opts.userId}` : '/host/home',
    PATH: '/skill/scripts:/bin',
    AWS_ACCESS_KEY_ID: 'ambient-key',
    AWS_PROFILE: 'host-profile',
  })),
}));

import config, { buildSpawnEnv } from '../config.js';
import { buildBackgroundShellEnv } from './background-shell-env.js';

const session = { id: 'session-a', owner_user_id: 'owner-a' } as SessionRow;
const project = {
  id: 'project-a',
  awsSsoProfiles: {
    musc: {
      sso_start_url: 'https://example.awsapps.com/start',
      sso_region: 'us-east-1',
      sso_account_id: '111111111111',
      sso_role_name: 'ReadOnly',
      region: 'us-east-1',
    },
    local: {
      type: 'static',
      aws_access_key_id: 'test-key',
      aws_secret_access_key: 'test-secret',
      region: 'us-west-2',
    },
  },
  awsDefaultProfile: 'musc',
} as unknown as Project;

beforeEach(() => {
  config.dataDir = mkdtempSync(path.join(os.tmpdir(), 'background-env-'));
});
afterEach(() => {
  rmSync(config.dataDir, { recursive: true, force: true });
  vi.clearAllMocks();
});

describe('buildBackgroundShellEnv', () => {
  it('provides project profiles and the session owner HOME without ambient credentials', () => {
    const env = buildBackgroundShellEnv(session, project);
    expect(buildSpawnEnv).toHaveBeenCalledWith(config, {
      userId: 'owner-a',
      sessionId: 'session-a',
    });
    expect(env.HOME).toBe('/users/owner-a');
    expect(env.AWS_PROFILE).toBe('musc');
    expect(env.AWS_ACCESS_KEY_ID).toBeUndefined();
    expect(readFileSync(env.AWS_CONFIG_FILE!, 'utf8')).toContain('[profile musc]');
    expect(readFileSync(env.AWS_SHARED_CREDENTIALS_FILE!, 'utf8')).toContain('[local]');
    expect(env.PROJECT_ID).toBe('project-a');
    expect(env.AGENT_HUB_URL).toBe('https://hub.example.test/prefix');
    expect(env.AGENT_HUB_SESSION_ID).toBe('session-a');
    expect(env.PATH).toBe('/skill/scripts:/bin');
  });

  it('refreshes profile files between starts and keeps projects separate', () => {
    const first = buildBackgroundShellEnv(session, project);
    const second = buildBackgroundShellEnv(session, { ...project, id: 'project-b' });
    expect(second.AWS_CONFIG_FILE).not.toBe(first.AWS_CONFIG_FILE);
    buildBackgroundShellEnv(session, {
      ...project,
      awsSsoProfiles: { renamed: project.awsSsoProfiles!.musc },
    });
    const contents = readFileSync(first.AWS_CONFIG_FILE!, 'utf8');
    expect(contents).toContain('[profile renamed]');
    expect(contents).not.toContain('[profile musc]');
  });

  it('refuses to run with host credentials when project files cannot be written', () => {
    writeFileSync(path.join(config.dataDir, 'project-aws-config'), 'not a directory');
    expect(() => buildBackgroundShellEnv(session, project)).toThrow(
      'Could not prepare the project AWS profiles',
    );
  });

  it('supports ownerless sessions and projects without profiles', () => {
    const env = buildBackgroundShellEnv({ ...session, owner_user_id: null }, null);
    expect(env.HOME).toBe('/host/home');
    expect(env.AWS_CONFIG_FILE).toBeUndefined();
    expect(env.PROJECT_ID).toBeUndefined();
  });
});
