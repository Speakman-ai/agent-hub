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
      'AWS_PROFILE',
      'AWS_DEFAULT_PROFILE',
    ]) {
      expect(Object.hasOwn(overlay, key)).toBe(true);
      expect(overlay[key]).toBeUndefined();
    }

    // The adapters materialize the PTY env by dropping undefined entries, so an
    // inherited AWS_PROFILE naming an unknown profile disappears.
    const merged: Record<string, string> = {};
    for (const [k, v] of Object.entries({ AWS_PROFILE: 'operator-only', ...overlay })) {
      if (v !== undefined) merged[k] = v;
    }
    expect(merged.AWS_PROFILE).toBeUndefined();
    expect(merged.AWS_CONFIG_FILE).toBeDefined();
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
