import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, symlinkSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
import type { Project } from '../types.js';

vi.mock('../config.js', () => ({
  default: { dataDir: '' },
}));

const { buildTerminalShellEnv } = await import('./terminal-shell-env.js');
const configMod = await import('../config.js');
const { perUserHomePath } = await import('../per-user-home.js');
const { hostCliHomePath } = await import('../host-cli-home.js');

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
    const overlay = buildTerminalShellEnv(projectWith({ dev: SSO_PROFILE }), {
      envKind: 'host',
      ownerUserId: null,
    });

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
      ownerUserId: null,
    });

    const credentials = readFileSync(overlay.AWS_SHARED_CREDENTIALS_FILE!, 'utf-8');
    expect(credentials).toContain('[prod]');
    expect(credentials).toContain('aws_access_key_id = AKIATESTKEY');
  });

  it('unsets ambient AWS credential vars so they cannot shadow the project files', () => {
    const overlay = buildTerminalShellEnv(projectWith({ dev: SSO_PROFILE }), {
      envKind: 'host',
      ownerUserId: null,
    });

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
    const overlay = buildTerminalShellEnv(projectWith({ dev: SSO_PROFILE }), {
      envKind: 'host',
      ownerUserId: null,
    });

    expect(overlay.AWS_PROFILE).toBe('dev');
    expect(readFileSync(overlay.AWS_CONFIG_FILE!, 'utf-8')).not.toContain('[default]');
  });

  it('exports the operator-designated default when the project has several profiles', () => {
    const project = {
      id: 'agent-hub',
      awsSsoProfiles: { dev: SSO_PROFILE, prod: STATIC_PROFILE },
      awsDefaultProfile: 'prod',
    } as unknown as Project;

    expect(buildTerminalShellEnv(project, { envKind: 'host', ownerUserId: null }).AWS_PROFILE).toBe(
      'prod',
    );
  });

  it('leaves AWS_PROFILE unset when several profiles exist and none is designated', () => {
    const overlay = buildTerminalShellEnv(projectWith({ dev: SSO_PROFILE, prod: STATIC_PROFILE }), {
      envKind: 'host',
      ownerUserId: null,
    });

    expect(Object.hasOwn(overlay, 'AWS_PROFILE')).toBe(true);
    expect(overlay.AWS_PROFILE).toBeUndefined();
  });

  it('leaves the terminal env untouched when the project configures no profiles', () => {
    expect(buildTerminalShellEnv(projectWith({}), { envKind: 'host', ownerUserId: null })).toEqual(
      {},
    );
    expect(buildTerminalShellEnv(null, { envKind: 'host', ownerUserId: null })).toEqual({});
  });

  it('skips a sysbox PTY, whose container cannot read Hub host paths', () => {
    expect(
      buildTerminalShellEnv(projectWith({ dev: SSO_PROFILE }), {
        envKind: 'sysbox',
        ownerUserId: null,
      }),
    ).toEqual({});
  });

  it('returns an empty overlay when rendering the project files fails', () => {
    (configMod.default as { dataDir: string }).dataDir = '\0invalid';
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(
      buildTerminalShellEnv(projectWith({ dev: SSO_PROFILE }), {
        envKind: 'host',
        ownerUserId: null,
      }),
    ).toEqual({});

    errorSpy.mockRestore();
  });

  describe('per-user HOME', () => {
    let serverHome: string;

    beforeEach(() => {
      serverHome = mkdtempSync(path.join(os.tmpdir(), 'terminal-server-home-'));
    });

    afterEach(() => {
      rmSync(serverHome, { recursive: true, force: true });
    });

    it('gives two users separate HOMEs, so one login never authenticates the other', () => {
      // Regression: every terminal kept the server HOME, so `aws sso login` in
      // one user's terminal was the SSO identity of every other terminal.
      const project = projectWith({ dev: SSO_PROFILE });
      const a = buildTerminalShellEnv(project, { envKind: 'host', ownerUserId: 'u1', serverHome });
      const b = buildTerminalShellEnv(project, { envKind: 'host', ownerUserId: 'u2', serverHome });

      expect(a.HOME).toBe(perUserHomePath('u1', tmpDataDir));
      expect(b.HOME).toBe(perUserHomePath('u2', tmpDataDir));
      expect(a.HOME).not.toBe(b.HOME);
      expect(a.HOME).not.toBe(serverHome);
      expect(a.AWS_CONFIG_FILE).toContain('project-aws-config/agent-hub/config');
      expect(b.AWS_CONFIG_FILE).toBe(a.AWS_CONFIG_FILE);
    });

    it('keeps the server HOME for an ownerless operator terminal', () => {
      const overlay = buildTerminalShellEnv(projectWith({ dev: SSO_PROFILE }), {
        envKind: 'host',
        ownerUserId: null,
        serverHome,
      });
      expect(Object.prototype.hasOwnProperty.call(overlay, 'HOME')).toBe(false);
    });

    it('pins HOME for an owned terminal even when the project has no AWS profiles', () => {
      const overlay = buildTerminalShellEnv(projectWith({}), {
        envKind: 'host',
        ownerUserId: 'u1',
        serverHome,
      });
      expect(overlay.HOME).toBe(perUserHomePath('u1', tmpDataDir));
      expect(overlay.AWS_CONFIG_FILE).toBeUndefined();
    });

    it("keeps git and gh on the server's config after moving HOME", () => {
      vi.stubEnv('GIT_CONFIG_GLOBAL', '');
      vi.stubEnv('GH_CONFIG_DIR', '');
      writeFileSync(path.join(serverHome, '.gitconfig'), '[user]\n  name = op\n');
      mkdirSync(path.join(serverHome, '.config', 'gh'), { recursive: true });
      const overlay = buildTerminalShellEnv(projectWith({}), {
        envKind: 'host',
        ownerUserId: 'u1',
        serverHome,
      });
      expect(overlay.GIT_CONFIG_GLOBAL).toBe(path.join(serverHome, '.gitconfig'));
      expect(overlay.GH_CONFIG_DIR).toBe(path.join(serverHome, '.config', 'gh'));
      vi.unstubAllEnvs();
    });

    it("disables AWS in a user's terminal whose SSO cache is still shared with the host", () => {
      const hostCache = path.join(hostCliHomePath(tmpDataDir), '.aws', 'sso', 'cache');
      mkdirSync(hostCache, { recursive: true });
      const userAws = path.join(perUserHomePath('u1', tmpDataDir), '.aws');
      mkdirSync(userAws, { recursive: true });
      // A link anywhere above the cache cannot be repaired, so AWS is refused.
      symlinkSync(path.join(hostCliHomePath(tmpDataDir), '.aws', 'sso'), path.join(userAws, 'sso'));
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const overlay = buildTerminalShellEnv(projectWith({ dev: SSO_PROFILE }), {
        envKind: 'host',
        ownerUserId: 'u1',
        serverHome,
      });

      warn.mockRestore();
      expect(overlay.AWS_CONFIG_FILE).toBe(os.devNull);
      expect(overlay.AWS_SHARED_CREDENTIALS_FILE).toBe(os.devNull);
      expect(overlay.AWS_PROFILE).toBeUndefined();
      expect(overlay.AGENT_HUB_AWS_DISABLED_REASON).toMatch(/not a private directory/);
    });
  });
});
