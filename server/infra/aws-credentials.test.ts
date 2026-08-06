/**
 * In-process credential resolution for a project AWS profile: what it reads,
 * what it refuses to read, how long it holds a resolved identity, and what
 * makes it let go.
 *
 * The SDK is mocked throughout. Nothing here spawns the `aws` CLI or reaches
 * AWS, per the guards in `server/test/setup.ts`.
 */
import '../test/setup.js';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import path from 'path';
import { fromIni } from '@aws-sdk/credential-providers';
import type { AwsCredentialIdentity } from '@smithy/types';
import config from '../config.js';
import { findProject } from '../project-model.js';
import { ProjectAwsProfileValidationError } from '../project-aws-profiles.js';
import type { ProjectAwsSsoProfilesMap } from '../project-aws-profiles.js';
import type { Project } from '../types.js';
import {
  resolveProjectAwsCredentials,
  invalidateProjectAwsCredentials,
  MonitoringProfileRequiredError,
} from './aws-credentials.js';

vi.mock('@aws-sdk/credential-providers', () => ({ fromIni: vi.fn() }));
vi.mock('../project-model.js', () => ({ findProject: vi.fn() }));

const fromIniMock = vi.mocked(fromIni);
const findProjectMock = vi.mocked(findProject);

const PROJECT_ID = 'infra-cred-proj';

const STATIC_PROFILE = {
  type: 'static' as const,
  aws_access_key_id: 'AKIAIOSFODNN7EXAMPLE',
  aws_secret_access_key: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
  region: 'us-east-2',
};

const ROLE_PROFILE = {
  type: 'role' as const,
  role_arn: 'arn:aws:iam::120569607241:role/AgentHubMonitoring',
  region: 'us-east-2',
};

const SSO_PROFILE = {
  sso_account_id: '120569607241',
  sso_start_url: 'https://d-9a670b4c46.awsapps.com/start/',
  sso_region: 'us-east-2',
  sso_role_name: 'AdministratorAccess',
  region: 'us-east-2',
};

/** Underlying providers `fromIni` handed back, in creation order. */
let providers: ReturnType<typeof vi.fn>[] = [];
/** Credentials the next underlying provider call resolves with. */
let nextCredentials: () => Promise<AwsCredentialIdentity>;

function setProfiles(profiles: ProjectAwsSsoProfilesMap, projectId = PROJECT_ID): void {
  findProjectMock.mockImplementation((id: string) =>
    id === projectId
      ? ({ id: projectId, name: projectId, awsSsoProfiles: profiles } as unknown as Project)
      : null,
  );
}

function projectAwsDir(projectId = PROJECT_ID): string {
  return path.join(config.dataDir, 'project-aws-config', projectId);
}

function creds(overrides: Partial<AwsCredentialIdentity> = {}): AwsCredentialIdentity {
  return {
    accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
    secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
    ...overrides,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-08-06T12:00:00Z'));
  invalidateProjectAwsCredentials();
  providers = [];
  nextCredentials = async () => creds();
  fromIniMock.mockReset();
  fromIniMock.mockImplementation(() => {
    const provider = vi.fn(() => nextCredentials());
    providers.push(provider);
    return provider as unknown as ReturnType<typeof fromIni>;
  });
  findProjectMock.mockReset();
  setProfiles({ monitoring: STATIC_PROFILE });
});

afterEach(() => {
  vi.useRealTimers();
  invalidateProjectAwsCredentials();
});

describe('resolveProjectAwsCredentials — what it reads', () => {
  it('resolves through fromIni against the project-scoped ini files, not the ambient chain', async () => {
    const provider = resolveProjectAwsCredentials(PROJECT_ID, 'monitoring');
    await provider();

    expect(fromIniMock).toHaveBeenCalledTimes(1);
    const init = fromIniMock.mock.calls[0][0]!;
    expect(init.profile).toBe('monitoring');
    expect(init.filepath).toBe(path.join(projectAwsDir(), 'credentials'));
    expect(init.configFilepath).toBe(path.join(projectAwsDir(), 'config'));
  });

  it('bypasses the shared-ini loader file cache so a rewritten ini is re-read', async () => {
    await resolveProjectAwsCredentials(PROJECT_ID, 'monitoring')();
    expect(fromIniMock.mock.calls[0][0]!.ignoreCache).toBe(true);
  });

  it('renders the ini files for a project that has never had a spawn', async () => {
    // A project id used by no other case here, so the assertion really is
    // "these files did not exist until resolution created them".
    const projectId = 'infra-cred-never-spawned';
    setProfiles({ monitoring: STATIC_PROFILE }, projectId);
    expect(existsSync(path.join(projectAwsDir(projectId), 'config'))).toBe(false);

    await resolveProjectAwsCredentials(projectId, 'monitoring')();

    const credentialsIni = readFileSync(
      path.join(projectAwsDir(projectId), 'credentials'),
      'utf-8',
    );
    expect(credentialsIni).toContain('[monitoring]');
    expect(credentialsIni).toContain(STATIC_PROFILE.aws_access_key_id);
    expect(readFileSync(path.join(projectAwsDir(projectId), 'config'), 'utf-8')).toContain(
      '[profile monitoring]',
    );
  });

  it('renders every profile, so a role can chain via source_profile', async () => {
    setProfiles({
      base: STATIC_PROFILE,
      monitoring: { ...ROLE_PROFILE, source_profile: 'base' },
    });

    await resolveProjectAwsCredentials(PROJECT_ID, 'monitoring')();

    const configIni = readFileSync(path.join(projectAwsDir(), 'config'), 'utf-8');
    expect(configIni).toContain('[profile base]');
    expect(configIni).toContain('source_profile = base');
  });

  it('ignores ambient AWS env vars — the selected profile still wins', async () => {
    vi.stubEnv('AWS_PROFILE', 'some-host-profile');
    vi.stubEnv('AWS_ACCESS_KEY_ID', 'AKIAHOSTKEYEXAMPLE0');
    vi.stubEnv('AWS_SECRET_ACCESS_KEY', 'hostsecret');
    try {
      await resolveProjectAwsCredentials(PROJECT_ID, 'monitoring')();
      const init = fromIniMock.mock.calls[0][0]!;
      expect(init.profile).toBe('monitoring');
      expect(init.filepath).toBe(path.join(projectAwsDir(), 'credentials'));
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('throws rather than falling back when the profile is not configured', () => {
    expect(() => resolveProjectAwsCredentials(PROJECT_ID, 'nope')).toThrow(
      ProjectAwsProfileValidationError,
    );
    expect(fromIniMock).not.toHaveBeenCalled();
  });

  it('throws when the project does not exist', () => {
    expect(() => resolveProjectAwsCredentials('ghost', 'monitoring')).toThrow(
      /unknown project "ghost"/,
    );
  });

  it('throws from the returned provider when the project is deleted after hand-off', async () => {
    const provider = resolveProjectAwsCredentials(PROJECT_ID, 'monitoring');
    findProjectMock.mockReturnValue(null);
    await expect(provider()).rejects.toThrow(ProjectAwsProfileValidationError);
  });
});

describe('resolveProjectAwsCredentials — SSO gating', () => {
  beforeEach(() => {
    setProfiles({ dev: SSO_PROFILE });
  });

  it('refuses an SSO profile for a background caller', () => {
    expect(() => resolveProjectAwsCredentials(PROJECT_ID, 'dev', { use: 'background' })).toThrow(
      MonitoringProfileRequiredError,
    );
  });

  it('defaults to the background arm, so an unflagged caller cannot get an SSO profile', () => {
    expect(() => resolveProjectAwsCredentials(PROJECT_ID, 'dev')).toThrow(
      MonitoringProfileRequiredError,
    );
  });

  it('carries the project and profile on the error for the empty state', () => {
    try {
      resolveProjectAwsCredentials(PROJECT_ID, 'dev');
      expect.unreachable('should have thrown');
    } catch (err) {
      const e = err as MonitoringProfileRequiredError;
      expect(e.name).toBe('MonitoringProfileRequiredError');
      expect(e.statusCode).toBe(409);
      expect(e.code).toBe('monitoring_profile_required');
      expect(e.projectId).toBe(PROJECT_ID);
      expect(e.profileName).toBe('dev');
      expect(e.reason).toBe('interactive_sso');
    }
  });

  it('allows an SSO profile for an interactive caller', async () => {
    const provider = resolveProjectAwsCredentials(PROJECT_ID, 'dev', { use: 'interactive' });
    await expect(provider()).resolves.toMatchObject({ accessKeyId: 'AKIAIOSFODNN7EXAMPLE' });
  });

  it('refuses at call time when a background profile is flipped to SSO after hand-off', async () => {
    setProfiles({ monitoring: STATIC_PROFILE });
    const provider = resolveProjectAwsCredentials(PROJECT_ID, 'monitoring');
    await provider();

    setProfiles({ monitoring: SSO_PROFILE });
    await expect(provider()).rejects.toThrow(MonitoringProfileRequiredError);
  });

  it('accepts a role profile for background use', () => {
    setProfiles({ monitoring: ROLE_PROFILE });
    expect(() => resolveProjectAwsCredentials(PROJECT_ID, 'monitoring')).not.toThrow();
  });
});

describe('provider cache', () => {
  it('builds one provider per (projectId, profileName) across repeat resolutions', async () => {
    await resolveProjectAwsCredentials(PROJECT_ID, 'monitoring')();
    await resolveProjectAwsCredentials(PROJECT_ID, 'monitoring')();

    expect(fromIniMock).toHaveBeenCalledTimes(1);
    expect(providers[0]).toHaveBeenCalledTimes(1);
  });

  it('keys separately per profile and per project', async () => {
    setProfiles({ monitoring: STATIC_PROFILE, other: ROLE_PROFILE });
    await resolveProjectAwsCredentials(PROJECT_ID, 'monitoring')();
    await resolveProjectAwsCredentials(PROJECT_ID, 'other')();
    expect(fromIniMock).toHaveBeenCalledTimes(2);

    setProfiles({ monitoring: STATIC_PROFILE }, 'second-project');
    await resolveProjectAwsCredentials('second-project', 'monitoring')();
    expect(fromIniMock).toHaveBeenCalledTimes(3);
  });

  it('dedupes concurrent refreshes into a single underlying resolution', async () => {
    let release!: (value: AwsCredentialIdentity) => void;
    nextCredentials = () =>
      new Promise<AwsCredentialIdentity>((resolve) => {
        release = resolve;
      });

    const provider = resolveProjectAwsCredentials(PROJECT_ID, 'monitoring');
    const both = Promise.all([provider(), provider()]);
    release(creds());
    const [a, b] = await both;

    expect(providers[0]).toHaveBeenCalledTimes(1);
    expect(a).toBe(b);
  });

  it('retries on the next call after a failed resolution instead of caching the failure', async () => {
    nextCredentials = async () => {
      throw new Error('could not load credentials');
    };
    const provider = resolveProjectAwsCredentials(PROJECT_ID, 'monitoring');
    await expect(provider()).rejects.toThrow('could not load credentials');

    nextCredentials = async () => creds();
    await expect(provider()).resolves.toMatchObject({ accessKeyId: 'AKIAIOSFODNN7EXAMPLE' });
    expect(providers[0]).toHaveBeenCalledTimes(2);
  });
});

describe('expiry-aware invalidation', () => {
  it('reuses credentials that are not near expiry', async () => {
    nextCredentials = async () => creds({ expiration: new Date(Date.now() + 60 * 60_000) });
    const provider = resolveProjectAwsCredentials(PROJECT_ID, 'monitoring');
    await provider();

    vi.advanceTimersByTime(30 * 60_000);
    await provider();

    expect(providers[0]).toHaveBeenCalledTimes(1);
  });

  it('re-resolves inside the 5-minute expiry skew, before the credentials actually expire', async () => {
    nextCredentials = async () => creds({ expiration: new Date(Date.now() + 10 * 60_000) });
    const provider = resolveProjectAwsCredentials(PROJECT_ID, 'monitoring');
    await provider();

    // 6 minutes in: 4 minutes of validity left, inside the skew.
    vi.advanceTimersByTime(6 * 60_000);
    await provider();

    expect(providers[0]).toHaveBeenCalledTimes(2);
  });

  it('re-resolves after expiry', async () => {
    nextCredentials = async () => creds({ expiration: new Date(Date.now() + 60_000) });
    const provider = resolveProjectAwsCredentials(PROJECT_ID, 'monitoring');
    await provider();

    vi.advanceTimersByTime(2 * 60_000);
    await provider();

    expect(providers[0]).toHaveBeenCalledTimes(2);
  });

  it('bounds how long credentials with no expiration are held', async () => {
    const provider = resolveProjectAwsCredentials(PROJECT_ID, 'monitoring');
    await provider();

    vi.advanceTimersByTime(14 * 60_000);
    await provider();
    expect(providers[0]).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(2 * 60_000);
    await provider();
    expect(providers[0]).toHaveBeenCalledTimes(2);
  });
});

describe('invalidateProjectAwsCredentials', () => {
  it('drops one project profile', async () => {
    setProfiles({ monitoring: STATIC_PROFILE, other: ROLE_PROFILE });
    await resolveProjectAwsCredentials(PROJECT_ID, 'monitoring')();
    await resolveProjectAwsCredentials(PROJECT_ID, 'other')();

    invalidateProjectAwsCredentials(PROJECT_ID, 'monitoring');
    await resolveProjectAwsCredentials(PROJECT_ID, 'monitoring')();
    await resolveProjectAwsCredentials(PROJECT_ID, 'other')();

    expect(fromIniMock).toHaveBeenCalledTimes(3);
  });

  it('drops every profile of one project and leaves other projects alone', async () => {
    setProfiles({ monitoring: STATIC_PROFILE, other: ROLE_PROFILE });
    await resolveProjectAwsCredentials(PROJECT_ID, 'monitoring')();
    await resolveProjectAwsCredentials(PROJECT_ID, 'other')();
    const beforeOtherProject = fromIniMock.mock.calls.length;

    invalidateProjectAwsCredentials(PROJECT_ID);
    await resolveProjectAwsCredentials(PROJECT_ID, 'monitoring')();
    await resolveProjectAwsCredentials(PROJECT_ID, 'other')();

    expect(fromIniMock).toHaveBeenCalledTimes(beforeOtherProject + 2);
  });

  it('re-renders the ini files on the next resolution after a clear', async () => {
    const provider = resolveProjectAwsCredentials(PROJECT_ID, 'monitoring');
    await provider();
    const configPath = path.join(projectAwsDir(), 'config');
    writeFileSync(configPath, '# clobbered\n', 'utf-8');

    invalidateProjectAwsCredentials(PROJECT_ID);
    await provider();

    expect(readFileSync(configPath, 'utf-8')).toContain('[profile monitoring]');
  });

  it('drops a stale provider when the profile definition changes without an explicit clear', async () => {
    const provider = resolveProjectAwsCredentials(PROJECT_ID, 'monitoring');
    await provider();

    setProfiles({
      monitoring: { ...STATIC_PROFILE, aws_secret_access_key: 'rotated-secret' },
    });
    await provider();

    expect(fromIniMock).toHaveBeenCalledTimes(2);
  });

  it('drops a chained role when only its source profile changed', async () => {
    setProfiles({ base: STATIC_PROFILE, monitoring: { ...ROLE_PROFILE, source_profile: 'base' } });
    const provider = resolveProjectAwsCredentials(PROJECT_ID, 'monitoring');
    await provider();

    setProfiles({
      base: { ...STATIC_PROFILE, aws_access_key_id: 'AKIAROTATEDEXAMPLE0' },
      monitoring: { ...ROLE_PROFILE, source_profile: 'base' },
    });
    await provider();

    expect(fromIniMock).toHaveBeenCalledTimes(2);
  });
});
