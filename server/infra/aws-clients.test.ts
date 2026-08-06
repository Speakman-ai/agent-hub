/**
 * The per-project AWS client seam: which profile a collector runs as, what a
 * client is built with, when clients are reused, and what the monitoring probe
 * reports.
 *
 * `@aws-sdk/client-cloudwatch` and the credential layer are both mocked, so no
 * AWS call and no CLI spawn happens here.
 */
import '../test/setup.js';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { CloudWatchClient, DescribeAlarmsCommand } from '@aws-sdk/client-cloudwatch';
import { findProject } from '../project-model.js';
import { ProjectAwsProfileValidationError } from '../project-aws-profiles.js';
import type { ProjectAwsSsoProfilesMap } from '../project-aws-profiles.js';
import type { Project } from '../types.js';
import {
  resolveProjectAwsCredentials,
  invalidateProjectAwsCredentials,
  getProjectAwsProfileRegion,
  MonitoringProfileRequiredError,
} from './aws-credentials.js';
import {
  requireProjectMonitoringProfile,
  getProjectCloudWatchClient,
  destroyProjectAwsClients,
  invalidateProjectAwsAccess,
  probeProjectMonitoringAccess,
} from './aws-clients.js';

interface FakeClient {
  config: Record<string, unknown>;
  send: ReturnType<typeof vi.fn>;
  destroy: ReturnType<typeof vi.fn>;
}

const { clients } = vi.hoisted(() => ({ clients: [] as FakeClient[] }));

vi.mock('@aws-sdk/client-cloudwatch', () => {
  const CloudWatchClient = vi.fn(function (this: FakeClient, config: Record<string, unknown>) {
    this.config = config;
    this.send = vi.fn(async () => ({ MetricAlarms: [] }));
    this.destroy = vi.fn();
    clients.push(this);
  });
  class DescribeAlarmsCommand {
    constructor(readonly input: Record<string, unknown>) {}
  }
  return { CloudWatchClient, DescribeAlarmsCommand };
});

vi.mock('../project-model.js', () => ({ findProject: vi.fn() }));

vi.mock('./aws-credentials.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./aws-credentials.js')>();
  return {
    ...actual,
    resolveProjectAwsCredentials: vi.fn(() => async () => ({
      accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
      secretAccessKey: 'secret',
    })),
    invalidateProjectAwsCredentials: vi.fn(),
    getProjectAwsProfileRegion: vi.fn(() => 'us-east-2'),
  };
});

const findProjectMock = vi.mocked(findProject);
const resolveCredentialsMock = vi.mocked(resolveProjectAwsCredentials);
const invalidateCredentialsMock = vi.mocked(invalidateProjectAwsCredentials);
const regionMock = vi.mocked(getProjectAwsProfileRegion);
const CloudWatchClientMock = vi.mocked(CloudWatchClient);

const PROJECT_ID = 'infra-clients-proj';

const STATIC_PROFILE = {
  type: 'static' as const,
  aws_access_key_id: 'AKIAIOSFODNN7EXAMPLE',
  aws_secret_access_key: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
  region: 'us-east-2',
};

const SSO_PROFILE = {
  sso_account_id: '120569607241',
  sso_start_url: 'https://d-9a670b4c46.awsapps.com/start/',
  sso_region: 'us-east-2',
  sso_role_name: 'AdministratorAccess',
  region: 'us-east-2',
};

function setProject(
  profiles: ProjectAwsSsoProfilesMap,
  monitoringProfile?: string | null,
  projectId = PROJECT_ID,
): void {
  findProjectMock.mockImplementation((id: string) =>
    id === projectId
      ? ({
          id: projectId,
          name: projectId,
          awsSsoProfiles: profiles,
          ...(monitoringProfile ? { awsMonitoringProfile: monitoringProfile } : {}),
        } as unknown as Project)
      : null,
  );
}

/** The config object the Nth constructed client was built with. */
function clientConfig(index: number): Record<string, unknown> {
  return CloudWatchClientMock.mock.calls[index][0] as unknown as Record<string, unknown>;
}

beforeEach(() => {
  destroyProjectAwsClients();
  vi.clearAllMocks();
  clients.length = 0;
  regionMock.mockReturnValue('us-east-2');
  resolveCredentialsMock.mockImplementation(() => async () => ({
    accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
    secretAccessKey: 'secret',
  }));
  setProject({ monitoring: STATIC_PROFILE }, 'monitoring');
});

describe('requireProjectMonitoringProfile', () => {
  it('returns the designated profile', () => {
    expect(requireProjectMonitoringProfile(PROJECT_ID)).toBe('monitoring');
  });

  it('refuses when nothing is designated, rather than inferring the sole profile', () => {
    setProject({ monitoring: STATIC_PROFILE }, null);
    try {
      requireProjectMonitoringProfile(PROJECT_ID);
      expect.unreachable('should have thrown');
    } catch (err) {
      const e = err as MonitoringProfileRequiredError;
      expect(e).toBeInstanceOf(MonitoringProfileRequiredError);
      expect(e.reason).toBe('not_designated');
      expect(e.statusCode).toBe(409);
    }
  });

  it('reports interactive_sso when the designated profile is an SSO profile', () => {
    // Reachable in practice: the save-time validator rejects designating an
    // SSO profile, but a designated static/role profile can later be edited to
    // SSO, and projects.json can be hand-edited.
    setProject({ monitoring: SSO_PROFILE }, 'monitoring');
    try {
      requireProjectMonitoringProfile(PROJECT_ID);
      expect.unreachable('should have thrown');
    } catch (err) {
      const e = err as MonitoringProfileRequiredError;
      expect(e.reason).toBe('interactive_sso');
      expect(e.profileName).toBe('monitoring');
      expect(e.message).toMatch(/IAM Identity Center/);
    }
  });

  it('reports not_designated when the designation names a profile that is gone', () => {
    setProject({ other: STATIC_PROFILE }, 'monitoring');
    try {
      requireProjectMonitoringProfile(PROJECT_ID);
      expect.unreachable('should have thrown');
    } catch (err) {
      const e = err as MonitoringProfileRequiredError;
      expect(e.reason).toBe('not_designated');
      expect(e.profileName).toBe('monitoring');
      expect(e.message).toMatch(/no longer a configured profile/);
    }
  });

  it('throws for an unknown project', () => {
    expect(() => requireProjectMonitoringProfile('ghost')).toThrow(
      ProjectAwsProfileValidationError,
    );
  });
});

describe('getProjectCloudWatchClient', () => {
  it('builds the client with the project credential provider, never the ambient chain', () => {
    getProjectCloudWatchClient(PROJECT_ID);

    expect(resolveCredentialsMock).toHaveBeenCalledWith(PROJECT_ID, 'monitoring', {
      use: 'background',
    });
    expect(clientConfig(0).credentials).toBe(resolveCredentialsMock.mock.results[0].value);
  });

  it("defaults the region to the profile's own stanza", () => {
    regionMock.mockReturnValue('eu-west-1');
    getProjectCloudWatchClient(PROJECT_ID);
    expect(clientConfig(0).region).toBe('eu-west-1');
  });

  it('defaults to the designated monitoring profile and the background arm', () => {
    getProjectCloudWatchClient(PROJECT_ID);
    expect(resolveCredentialsMock).toHaveBeenCalledWith(PROJECT_ID, 'monitoring', {
      use: 'background',
    });
  });

  it('honours an explicit profile, region and use', () => {
    setProject({ monitoring: STATIC_PROFILE, dev: SSO_PROFILE }, 'monitoring');
    getProjectCloudWatchClient(PROJECT_ID, {
      profileName: 'dev',
      region: 'ap-south-1',
      use: 'interactive',
    });

    expect(resolveCredentialsMock).toHaveBeenCalledWith(PROJECT_ID, 'dev', { use: 'interactive' });
    expect(clientConfig(0).region).toBe('ap-south-1');
  });

  it('reuses one client per (project, profile, region)', () => {
    const a = getProjectCloudWatchClient(PROJECT_ID);
    const b = getProjectCloudWatchClient(PROJECT_ID);
    expect(a).toBe(b);
    expect(CloudWatchClientMock).toHaveBeenCalledTimes(1);
  });

  it('builds a separate client per region', () => {
    getProjectCloudWatchClient(PROJECT_ID, { region: 'us-east-2' });
    getProjectCloudWatchClient(PROJECT_ID, { region: 'eu-west-1' });
    expect(CloudWatchClientMock).toHaveBeenCalledTimes(2);
  });

  it('does not hand an interactive client to a background caller', () => {
    setProject({ dev: SSO_PROFILE }, 'monitoring');
    const interactive = getProjectCloudWatchClient(PROJECT_ID, {
      profileName: 'dev',
      use: 'interactive',
    });
    const background = getProjectCloudWatchClient(PROJECT_ID, {
      profileName: 'dev',
      use: 'background',
    });

    expect(background).not.toBe(interactive);
    expect(resolveCredentialsMock).toHaveBeenNthCalledWith(2, PROJECT_ID, 'dev', {
      use: 'background',
    });
  });

  it('cannot reuse an interactive SSO client to bypass the background refusal', () => {
    setProject({ dev: SSO_PROFILE }, 'monitoring');
    // The real credential layer refuses `background` + SSO; mirror that here so
    // the cache cannot short-circuit the refusal by returning a client built
    // for an interactive caller.
    resolveCredentialsMock.mockImplementation((projectId, profileName, opts) => {
      if ((opts?.use ?? 'background') === 'background') {
        throw new MonitoringProfileRequiredError(projectId, profileName, 'interactive_sso');
      }
      return async () => ({ accessKeyId: 'AKIAIOSFODNN7EXAMPLE', secretAccessKey: 'secret' });
    });

    getProjectCloudWatchClient(PROJECT_ID, { profileName: 'dev', use: 'interactive' });

    expect(() =>
      getProjectCloudWatchClient(PROJECT_ID, { profileName: 'dev', use: 'background' }),
    ).toThrow(MonitoringProfileRequiredError);
  });

  it('fails at construction when the project has no usable monitoring profile', () => {
    setProject({ monitoring: STATIC_PROFILE }, null);
    expect(() => getProjectCloudWatchClient(PROJECT_ID)).toThrow(MonitoringProfileRequiredError);
    expect(CloudWatchClientMock).not.toHaveBeenCalled();
  });
});

describe('invalidateProjectAwsAccess', () => {
  it('clears credentials and destroys the clients holding them', () => {
    const client = getProjectCloudWatchClient(PROJECT_ID);

    invalidateProjectAwsAccess(PROJECT_ID);

    expect(invalidateCredentialsMock).toHaveBeenCalledWith(PROJECT_ID);
    expect(client.destroy).toHaveBeenCalledTimes(1);
    expect(getProjectCloudWatchClient(PROJECT_ID)).not.toBe(client);
  });

  it('leaves other projects alone', () => {
    const mine = getProjectCloudWatchClient(PROJECT_ID);
    setProject({ monitoring: STATIC_PROFILE }, 'monitoring', 'other-project');
    const theirs = getProjectCloudWatchClient('other-project');

    setProject({ monitoring: STATIC_PROFILE }, 'monitoring');
    invalidateProjectAwsAccess(PROJECT_ID);

    expect(mine.destroy).toHaveBeenCalledTimes(1);
    expect(theirs.destroy).not.toHaveBeenCalled();
  });
});

describe('probeProjectMonitoringAccess', () => {
  it('probes CloudWatch with a single-record DescribeAlarms, never a billed metric read', async () => {
    const probe = await probeProjectMonitoringAccess(PROJECT_ID);

    expect(probe).toMatchObject({ profile: 'monitoring', region: 'us-east-2', reachable: true });
    const command = clients[0].send.mock.calls[0][0] as InstanceType<typeof DescribeAlarmsCommand>;
    expect(command).toBeInstanceOf(DescribeAlarmsCommand);
    expect((command as unknown as { input: { MaxRecords: number } }).input.MaxRecords).toBe(1);
  });

  it('reports the typed refusal when no monitoring profile is designated', async () => {
    setProject({ monitoring: STATIC_PROFILE }, null);

    const probe = await probeProjectMonitoringAccess(PROJECT_ID);

    expect(probe.reachable).toBe(false);
    expect(probe.code).toBe('monitoring_profile_required');
    expect(probe.reason).toBe('not_designated');
    expect(probe.profile).toBeNull();
  });

  it('distinguishes an SSO designation from no designation at all', async () => {
    setProject({ monitoring: SSO_PROFILE }, 'monitoring');

    const probe = await probeProjectMonitoringAccess(PROJECT_ID);

    expect(probe.code).toBe('monitoring_profile_required');
    expect(probe.reason).toBe('interactive_sso');
    expect(probe.profile).toBe('monitoring');
  });

  it('surfaces an AWS failure without throwing', async () => {
    getProjectCloudWatchClient(PROJECT_ID);
    const denied = Object.assign(new Error('User is not authorized to perform: cloudwatch:Desc'), {
      name: 'AccessDeniedException',
    });
    clients[0].send.mockRejectedValueOnce(denied);

    const probe = await probeProjectMonitoringAccess(PROJECT_ID);

    expect(probe.reachable).toBe(false);
    expect(probe.code).toBe('AccessDeniedException');
    expect(probe.profile).toBe('monitoring');
    expect(probe.region).toBe('us-east-2');
  });

  it('never returns credential material', async () => {
    const probe = await probeProjectMonitoringAccess(PROJECT_ID);
    expect(JSON.stringify(probe)).not.toContain(STATIC_PROFILE.aws_secret_access_key);
    expect(JSON.stringify(probe)).not.toContain(STATIC_PROFILE.aws_access_key_id);
  });
});
