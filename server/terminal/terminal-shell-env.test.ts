import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'fs';
import os from 'os';
import path from 'path';
import type { Project } from '../types.js';

vi.mock('../config.js', () => ({
  default: { dataDir: '' },
}));

const { buildTerminalShellEnv } = await import('./terminal-shell-env.js');
const configMod = await import('../config.js');

function projectWith(profiles: Record<string, unknown>): Project {
  return { id: 'agent-hub', awsSsoProfiles: profiles } as unknown as Project;
}

const SSO_PROFILE = {
  sso_start_url: 'https://example.awsapps.com/start',
  sso_region: 'us-east-1',
  sso_account_id: '111111111111',
  sso_role_name: 'Admin',
  region: 'us-east-1',
};

const STATIC_PROFILE = {
  type: 'static',
  aws_access_key_id: 'AKIATESTKEY',
  aws_secret_access_key: 'secret-test-key',
  region: 'us-east-1',
};

describe('buildTerminalShellEnv', () => {
  let tmpDataDir: string;

  beforeEach(() => {
    tmpDataDir = mkdtempSync(path.join(os.tmpdir(), 'terminal-shell-env-'));
    (configMod.default as { dataDir: string }).dataDir = tmpDataDir;
  });

  afterEach(() => {
    rmSync(tmpDataDir, { recursive: true, force: true });
  });

  // The regression: the terminal PTY inherited only the Hub process env, so
  // `aws --profile <name>` in the Terminal tab could not see the project's
  // profiles even though the agent's own spawns could.
  it('points the shell at the project AWS config and credentials files', () => {
    const overlay = buildTerminalShellEnv(projectWith({ dev: SSO_PROFILE }), { envKind: 'host' });

    expect(overlay.AWS_CONFIG_FILE).toBe(
      path.join(tmpDataDir, 'project-aws-config', 'agent-hub', 'config'),
    );
    expect(overlay.AWS_SHARED_CREDENTIALS_FILE).toBe(
      path.join(tmpDataDir, 'project-aws-config', 'agent-hub', 'credentials'),
    );
    expect(overlay.AGENT_HUB_AWS_PROFILE_NAMES).toBe('dev');
    expect(readFileSync(overlay.AWS_CONFIG_FILE!, 'utf-8')).toContain('[profile dev]');
  });

  it('renders static profiles into the credentials file the shell reads', () => {
    const overlay = buildTerminalShellEnv(projectWith({ prod: STATIC_PROFILE }), {
      envKind: 'host',
    });

    const credentials = readFileSync(overlay.AWS_SHARED_CREDENTIALS_FILE!, 'utf-8');
    expect(credentials).toContain('[prod]');
    expect(credentials).toContain('aws_access_key_id = AKIATESTKEY');
  });

  it('unsets ambient AWS credential vars so they cannot shadow the project files', () => {
    const overlay = buildTerminalShellEnv(projectWith({ dev: SSO_PROFILE }), { envKind: 'host' });

    for (const key of [
      'AWS_ACCESS_KEY_ID',
      'AWS_SECRET_ACCESS_KEY',
      'AWS_SESSION_TOKEN',
      'AWS_SECURITY_TOKEN',
      'AWS_DEFAULT_PROFILE',
    ]) {
      expect(Object.hasOwn(overlay, key)).toBe(true);
      expect(overlay[key]).toBeUndefined();
    }

    // The adapters materialize the PTY env by dropping undefined entries, so an
    // inherited AWS_PROFILE naming a profile outside this project disappears —
    // replaced by the project's own default rather than left to shadow it.
    const merged: Record<string, string> = {};
    for (const [k, v] of Object.entries({ AWS_PROFILE: 'operator-only', ...overlay })) {
      if (v !== undefined) merged[k] = v;
    }
    expect(merged.AWS_PROFILE).toBe('dev');
    expect(merged.AWS_CONFIG_FILE).toBeDefined();
  });

  // The regression this ticket fixes: the generated config has no `[default]`
  // section, so `aws sso login` with no `--profile` died with "Missing the
  // following required SSO configuration values: sso_start_url, sso_region".
  it('exports the sole profile as AWS_PROFILE so un-flagged aws commands resolve', () => {
    const overlay = buildTerminalShellEnv(projectWith({ dev: SSO_PROFILE }), { envKind: 'host' });

    expect(overlay.AWS_PROFILE).toBe('dev');
    expect(readFileSync(overlay.AWS_CONFIG_FILE!, 'utf-8')).not.toContain('[default]');
  });

  it('exports the operator-designated default when the project has several profiles', () => {
    const project = {
      id: 'agent-hub',
      awsSsoProfiles: { dev: SSO_PROFILE, prod: STATIC_PROFILE },
      awsDefaultProfile: 'prod',
    } as unknown as Project;

    expect(buildTerminalShellEnv(project, { envKind: 'host' }).AWS_PROFILE).toBe('prod');
  });

  it('leaves AWS_PROFILE unset when several profiles exist and none is designated', () => {
    const overlay = buildTerminalShellEnv(projectWith({ dev: SSO_PROFILE, prod: STATIC_PROFILE }), {
      envKind: 'host',
    });

    expect(Object.hasOwn(overlay, 'AWS_PROFILE')).toBe(true);
    expect(overlay.AWS_PROFILE).toBeUndefined();
  });

  it('leaves the terminal env untouched when the project configures no profiles', () => {
    expect(buildTerminalShellEnv(projectWith({}), { envKind: 'host' })).toEqual({});
    expect(buildTerminalShellEnv(null, { envKind: 'host' })).toEqual({});
  });

  it('skips a sysbox PTY, whose container cannot read Hub host paths', () => {
    expect(buildTerminalShellEnv(projectWith({ dev: SSO_PROFILE }), { envKind: 'sysbox' })).toEqual(
      {},
    );
  });

  it('returns an empty overlay when rendering the project files fails', () => {
    (configMod.default as { dataDir: string }).dataDir = '\0invalid';
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(buildTerminalShellEnv(projectWith({ dev: SSO_PROFILE }), { envKind: 'host' })).toEqual(
      {},
    );

    errorSpy.mockRestore();
  });
});
