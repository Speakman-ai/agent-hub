/**
 * Codex chat spawn must forward project AWS SSO env and widen sandbox when
 * `codexDangerBypass` is off — regression for bug where `--full-auto` blocked
 * `aws` from reading `AWS_CONFIG_FILE` and `~/.aws/sso/cache`.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'fs';
import os from 'os';
import path from 'path';
import type { Project } from './types.js';
import { appendCodexAwsAccessDirs, appendCodexExecSandboxFlags } from './codex-exec-sandbox.js';
import { mergeProjectAwsSpawnEnv } from './project-aws-spawn.js';

vi.mock('./config.js', () => ({
  default: { dataDir: '' },
}));

const configMod = await import('./config.js');

describe('codex chat AWS SSO spawn contract', () => {
  let tmpDataDir: string;

  beforeEach(() => {
    tmpDataDir = mkdtempSync(path.join(os.tmpdir(), 'chat-codex-aws-'));
    (configMod.default as { dataDir: string }).dataDir = tmpDataDir;
  });

  afterEach(() => {
    rmSync(tmpDataDir, { recursive: true, force: true });
  });

  it('mergeProjectAwsSpawnEnv injects AWS_CONFIG_FILE and profile names into child env', () => {
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
    const env: NodeJS.ProcessEnv = {
      HOME: path.join(tmpDataDir, 'per-user', 'home'),
      PATH: '/usr/bin',
    };
    mkdirSync(env.HOME!, { recursive: true, mode: 0o700 });

    mergeProjectAwsSpawnEnv(env, project);

    expect(env.AWS_CONFIG_FILE).toContain('project-aws-config/agent-hub/config');
    expect(env.AGENT_HUB_AWS_PROFILE_NAMES).toBe('dev');
  });

  it('codex argv uses danger-full-access + add-dir when AWS SSO is on and dangerBypass is off', () => {
    const home = path.join(tmpDataDir, 'u1', 'home');
    const awsConfig = path.join(tmpDataDir, 'project-aws-config', 'p1', 'config');
    const args: string[] = ['exec', '--json', '--skip-git-repo-check'];

    appendCodexExecSandboxFlags(args, {
      askMode: false,
      dangerBypass: false,
      awsSsoEnabled: true,
    });
    appendCodexAwsAccessDirs(args, { HOME: home, AWS_CONFIG_FILE: awsConfig });

    expect(args).toContain('--sandbox');
    expect(args).toContain('danger-full-access');
    expect(args).not.toContain('--full-auto');
    expect(args).not.toContain('-c');
    expect(args).toContain('--add-dir');
    expect(args).toContain(path.dirname(awsConfig));
    expect(args).toContain(path.join(home, '.aws'));
  });
});
