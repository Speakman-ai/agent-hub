import { describe, it, expect, vi } from 'vitest';
import {
  validateProjectAwsSsoProfiles,
  validateProjectAwsDefaultProfile,
  resolveProjectAwsDefaultProfile,
  renderProjectAwsConfigIni,
  renderProjectAwsCredentialsIni,
  resolveAmbientCredentialSource,
  effectiveRoleCredentialSource,
  ProjectAwsProfileValidationError,
  AWS_CREDENTIAL_SOURCES,
  AWS_CREDENTIAL_SOURCE_ENV,
  type ProjectAwsSsoProfilesMap,
} from './project-aws-profiles.js';

const VALID = {
  sso_account_id: '120569607241',
  sso_start_url: 'https://d-9a670b4c46.awsapps.com/start/#',
  sso_region: 'us-east-2',
  sso_role_name: 'AdministratorAccess',
  region: 'us-east-2',
};

const ROLE_ARN = 'arn:aws:iam::120569607241:role/AgentHubMonitoring';

describe('validateProjectAwsSsoProfiles', () => {
  it('accepts a profile map and strips trailing # from start url', () => {
    const profiles = validateProjectAwsSsoProfiles({ dev: VALID });
    expect(profiles.dev).toMatchObject({
      type: 'sso',
      sso_start_url: 'https://d-9a670b4c46.awsapps.com/start/',
    });
  });

  it('accepts an array with name field', () => {
    const profiles = validateProjectAwsSsoProfiles([{ name: 'staging', ...VALID }]);
    expect(profiles.staging).toMatchObject({
      type: 'sso',
      sso_account_id: VALID.sso_account_id,
    });
  });

  it('accepts static credentials profiles', () => {
    const profiles = validateProjectAwsSsoProfiles({
      dev: {
        type: 'static',
        aws_access_key_id: 'AKIATESTKEY',
        aws_secret_access_key: 'secret-test-key',
        aws_session_token: 'session-token',
        region: 'us-east-2',
      },
    });
    expect(profiles.dev.type).toBe('static');
    expect(profiles.dev.region).toBe('us-east-2');
  });

  it('infers static credentials profiles from access key fields', () => {
    const profiles = validateProjectAwsSsoProfiles({
      dev: {
        aws_access_key_id: 'AKIATESTKEY',
        aws_secret_access_key: 'secret-test-key',
        region: 'us-east-2',
      },
    });
    expect(profiles.dev.type).toBe('static');
  });

  it('rejects reserved-ish profile names', () => {
    expect(() => validateProjectAwsSsoProfiles({ 'bad name': VALID })).toThrow(
      ProjectAwsProfileValidationError,
    );
  });
});

describe('validateProjectAwsSsoProfiles — role profiles', () => {
  it('accepts a role profile and keeps its optional fields', () => {
    const profiles = validateProjectAwsSsoProfiles({
      monitoring: {
        type: 'role',
        role_arn: ' arn:aws:iam::120569607241:role/AgentHubMonitoring ',
        external_id: ' ext-123 ',
        role_session_name: 'agent-hub',
        credential_source: 'Ec2InstanceMetadata',
        region: 'us-east-2',
      },
    });
    expect(profiles.monitoring).toEqual({
      type: 'role',
      role_arn: 'arn:aws:iam::120569607241:role/AgentHubMonitoring',
      external_id: 'ext-123',
      role_session_name: 'agent-hub',
      credential_source: 'Ec2InstanceMetadata',
      region: 'us-east-2',
    });
  });

  it('infers a role profile from role_arn when type is omitted', () => {
    const profiles = validateProjectAwsSsoProfiles({
      monitoring: { role_arn: ROLE_ARN, region: 'us-east-2' },
    });
    expect(profiles.monitoring.type).toBe('role');
  });

  it('accepts partitioned and pathed role ARNs', () => {
    for (const arn of [
      'arn:aws-us-gov:iam::120569607241:role/Monitoring',
      'arn:aws-cn:iam::120569607241:role/Monitoring',
      'arn:aws:iam::120569607241:role/service-path/Monitoring',
    ]) {
      expect(
        validateProjectAwsSsoProfiles({ mon: { type: 'role', role_arn: arn, region: 'us-east-2' } })
          .mon,
      ).toMatchObject({ type: 'role', role_arn: arn });
    }
  });

  it('rejects anything that is not an IAM role ARN', () => {
    for (const arn of [
      'arn:aws:iam::120569607241:user/Someone',
      'arn:aws:iam::12056:role/Monitoring',
      'arn:aws:iam::120569607241:role/',
      'AgentHubMonitoring',
    ]) {
      expect(() =>
        validateProjectAwsSsoProfiles({
          mon: { type: 'role', role_arn: arn, region: 'us-east-2' },
        }),
      ).toThrow(ProjectAwsProfileValidationError);
    }
  });

  it('requires role_arn', () => {
    expect(() =>
      validateProjectAwsSsoProfiles({ mon: { type: 'role', region: 'us-east-2' } }),
    ).toThrow(/role_arn is required/);
  });

  it('rejects a multi-line external id', () => {
    expect(() =>
      validateProjectAwsSsoProfiles({
        mon: { type: 'role', role_arn: ROLE_ARN, external_id: 'a\nb', region: 'us-east-2' },
      }),
    ).toThrow(/single-line/);
  });

  it('rejects an unknown credential_source', () => {
    expect(() =>
      validateProjectAwsSsoProfiles({
        mon: {
          type: 'role',
          role_arn: ROLE_ARN,
          credential_source: 'InstanceProfile',
          region: 'us-east-2',
        },
      }),
    ).toThrow(/credential_source must be one of/);
  });

  // The AWS CLI errors on a stanza carrying both origins, so reject at save
  // time rather than shipping a config file that fails on first use.
  it('rejects source_profile and credential_source together', () => {
    expect(() =>
      validateProjectAwsSsoProfiles({
        base: VALID,
        mon: {
          type: 'role',
          role_arn: ROLE_ARN,
          source_profile: 'base',
          credential_source: 'Ec2InstanceMetadata',
          region: 'us-east-2',
        },
      }),
    ).toThrow(/not both/);
  });

  it('rejects a source_profile that names no configured profile', () => {
    expect(() =>
      validateProjectAwsSsoProfiles({
        mon: { type: 'role', role_arn: ROLE_ARN, source_profile: 'gone', region: 'us-east-2' },
      }),
    ).toThrow(/is not a configured profile/);
  });

  it('rejects self-referential and circular chains', () => {
    expect(() =>
      validateProjectAwsSsoProfiles({
        mon: { type: 'role', role_arn: ROLE_ARN, source_profile: 'mon', region: 'us-east-2' },
      }),
    ).toThrow(/cannot reference itself/);
    expect(() =>
      validateProjectAwsSsoProfiles({
        a: { type: 'role', role_arn: ROLE_ARN, source_profile: 'b', region: 'us-east-2' },
        b: { type: 'role', role_arn: ROLE_ARN, source_profile: 'a', region: 'us-east-2' },
      }),
    ).toThrow(/circular/);
  });

  it('accepts a role chained onto a static profile', () => {
    const profiles = validateProjectAwsSsoProfiles({
      base: {
        type: 'static',
        aws_access_key_id: 'AKIATESTKEY',
        aws_secret_access_key: 'secret-test-key',
        region: 'us-east-2',
      },
      mon: { type: 'role', role_arn: ROLE_ARN, source_profile: 'base', region: 'us-east-2' },
    });
    expect(profiles.mon).toMatchObject({ type: 'role', source_profile: 'base' });
  });

  it('rejects an unknown profile type', () => {
    expect(() =>
      validateProjectAwsSsoProfiles({ mon: { type: 'oidc', region: 'us-east-2' } }),
    ).toThrow(/"sso", "static" or "role"/);
  });

  it('round-trips a role profile through the array form', () => {
    const profiles = validateProjectAwsSsoProfiles([
      { name: 'mon', type: 'role', role_arn: ROLE_ARN, region: 'us-east-2' },
    ]);
    expect(profiles.mon).toEqual({ type: 'role', role_arn: ROLE_ARN, region: 'us-east-2' });
  });
});

describe('renderProjectAwsConfigIni', () => {
  it('renders profile sections', () => {
    const ini = renderProjectAwsConfigIni({ dev: VALID, prod: { ...VALID, region: 'us-west-2' } });
    expect(ini).toContain('[profile dev]');
    expect(ini).toContain('sso_account_id = 120569607241');
    expect(ini).toContain('[profile prod]');
    expect(ini).toContain('region = us-west-2');
  });

  it('renders static profiles without keys in the config file', () => {
    const ini = renderProjectAwsConfigIni({
      dev: {
        type: 'static',
        aws_access_key_id: 'AKIATESTKEY',
        aws_secret_access_key: 'secret-test-key',
        region: 'us-east-2',
      },
    });
    expect(ini).toContain('[profile dev]');
    expect(ini).toContain('region = us-east-2');
    expect(ini).not.toContain('aws_access_key_id');
    expect(ini).not.toContain('secret-test-key');
  });

  it('renders a role profile against the Hub ambient credentials by default', () => {
    const ini = renderProjectAwsConfigIni(
      {
        mon: {
          type: 'role',
          role_arn: ROLE_ARN,
          external_id: 'ext-123',
          role_session_name: 'agent-hub',
          region: 'us-east-2',
        },
      },
      { defaultCredentialSource: 'Ec2InstanceMetadata' },
    );
    expect(ini).toBe(
      [
        '[profile mon]',
        `role_arn = ${ROLE_ARN}`,
        'external_id = ext-123',
        'role_session_name = agent-hub',
        'credential_source = Ec2InstanceMetadata',
        'region = us-east-2',
        'output = json',
        '',
      ].join('\n'),
    );
  });

  it('honours an explicit credential_source', () => {
    const ini = renderProjectAwsConfigIni({
      mon: {
        type: 'role',
        role_arn: ROLE_ARN,
        credential_source: 'EcsContainer',
        region: 'us-east-2',
      },
    });
    expect(ini).toContain('credential_source = EcsContainer');
  });

  // Both keys in one stanza is a CLI error, so a chained role emits only
  // source_profile.
  it('emits source_profile instead of credential_source when chained', () => {
    const ini = renderProjectAwsConfigIni({
      base: VALID,
      mon: { type: 'role', role_arn: ROLE_ARN, source_profile: 'base', region: 'us-west-2' },
    });
    expect(ini).toContain('source_profile = base');
    expect(ini).not.toContain('credential_source');
  });

  it('keeps role stanzas free of SSO keys', () => {
    const ini = renderProjectAwsConfigIni({
      mon: { type: 'role', role_arn: ROLE_ARN, region: 'us-east-2' },
    });
    expect(ini).not.toContain('sso_');
  });

  // The reviewed bug: every unchained role rendered `Ec2InstanceMetadata`,
  // which only resolves on an EC2 instance-profile host.
  it('renders the credential source the deployment actually provides', () => {
    const profiles: ProjectAwsSsoProfilesMap = {
      mon: { type: 'role', role_arn: ROLE_ARN, region: 'us-east-2' },
    };
    for (const source of AWS_CREDENTIAL_SOURCES) {
      expect(renderProjectAwsConfigIni(profiles, { defaultCredentialSource: source })).toContain(
        `credential_source = ${source}`,
      );
    }
  });

  it('lets a profile pin a source the Hub runtime does not provide', () => {
    const ini = renderProjectAwsConfigIni(
      {
        mon: {
          type: 'role',
          role_arn: ROLE_ARN,
          credential_source: 'EcsContainer',
          region: 'us-east-2',
        },
      },
      { defaultCredentialSource: 'Ec2InstanceMetadata' },
    );
    expect(ini).toContain('credential_source = EcsContainer');
    expect(ini).not.toContain('Ec2InstanceMetadata');
  });

  it('never applies the ambient default to a chained role', () => {
    const ini = renderProjectAwsConfigIni(
      {
        base: VALID,
        mon: { type: 'role', role_arn: ROLE_ARN, source_profile: 'base', region: 'us-east-2' },
      },
      { defaultCredentialSource: 'EcsContainer' },
    );
    expect(ini).toContain('source_profile = base');
    expect(ini).not.toContain('credential_source');
  });
});

describe('resolveAmbientCredentialSource', () => {
  // One case per deployment shape the Hub actually runs in.
  it('detects an ECS / Fargate task from the container credential endpoint', () => {
    expect(
      resolveAmbientCredentialSource({
        AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: '/v2/credentials/abc',
      }),
    ).toBe('EcsContainer');
    expect(
      resolveAmbientCredentialSource({
        AWS_CONTAINER_CREDENTIALS_FULL_URI: 'http://169.254.170.23/v1/credentials',
      }),
    ).toBe('EcsContainer');
  });

  it('detects ambient key env vars', () => {
    expect(
      resolveAmbientCredentialSource({
        AWS_ACCESS_KEY_ID: 'AKIATESTKEY',
        AWS_SECRET_ACCESS_KEY: 'secret-test-key',
      }),
    ).toBe('Environment');
  });

  it('requires both key vars before claiming Environment', () => {
    expect(resolveAmbientCredentialSource({ AWS_ACCESS_KEY_ID: 'AKIATESTKEY' })).toBe(
      'Ec2InstanceMetadata',
    );
    expect(resolveAmbientCredentialSource({ AWS_ACCESS_KEY_ID: '  ' })).toBe('Ec2InstanceMetadata');
  });

  it('falls back to instance metadata on a bare EC2 host', () => {
    expect(resolveAmbientCredentialSource({})).toBe('Ec2InstanceMetadata');
  });

  it('prefers the container endpoint over ambient key vars', () => {
    expect(
      resolveAmbientCredentialSource({
        AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: '/v2/credentials/abc',
        AWS_ACCESS_KEY_ID: 'AKIATESTKEY',
        AWS_SECRET_ACCESS_KEY: 'secret-test-key',
      }),
    ).toBe('EcsContainer');
  });

  it('honours the operator override over every detected signal', () => {
    expect(
      resolveAmbientCredentialSource({
        [AWS_CREDENTIAL_SOURCE_ENV]: 'Ec2InstanceMetadata',
        AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: '/v2/credentials/abc',
      }),
    ).toBe('Ec2InstanceMetadata');
    // Operators type what they remember, not what the CLI spells.
    expect(resolveAmbientCredentialSource({ [AWS_CREDENTIAL_SOURCE_ENV]: ' ecscontainer ' })).toBe(
      'EcsContainer',
    );
  });

  it('ignores an unparseable override rather than rendering it verbatim', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(
        resolveAmbientCredentialSource({
          [AWS_CREDENTIAL_SOURCE_ENV]: 'InstanceProfile',
          AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: '/v2/credentials/abc',
        }),
      ).toBe('EcsContainer');
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});

describe('effectiveRoleCredentialSource', () => {
  it('reports null for a chained role and the resolved source otherwise', () => {
    const base = { type: 'role', role_arn: ROLE_ARN, region: 'us-east-2' } as const;
    expect(effectiveRoleCredentialSource({ ...base, source_profile: 'base' }, 'EcsContainer')).toBe(
      null,
    );
    expect(effectiveRoleCredentialSource(base, 'EcsContainer')).toBe('EcsContainer');
    expect(
      effectiveRoleCredentialSource({ ...base, credential_source: 'Environment' }, 'EcsContainer'),
    ).toBe('Environment');
  });
});

describe('renderProjectAwsCredentialsIni', () => {
  it('renders only static profile credentials', () => {
    const ini = renderProjectAwsCredentialsIni({
      dev: {
        type: 'static',
        aws_access_key_id: 'AKIATESTKEY',
        aws_secret_access_key: 'secret-test-key',
        aws_session_token: 'session-token',
        region: 'us-east-2',
      },
      prod: VALID,
    });
    expect(ini).toContain('[dev]');
    expect(ini).toContain('aws_access_key_id = AKIATESTKEY');
    expect(ini).toContain('aws_secret_access_key = secret-test-key');
    expect(ini).toContain('aws_session_token = session-token');
    expect(ini).not.toContain('[prod]');
  });

  it('leaves role profiles out of the credentials file', () => {
    const ini = renderProjectAwsCredentialsIni({
      mon: { type: 'role', role_arn: ROLE_ARN, external_id: 'ext-123', region: 'us-east-2' },
    });
    expect(ini).toBe('');
  });
});

describe('validateProjectAwsDefaultProfile', () => {
  it('normalizes absent / empty designations to null', () => {
    for (const raw of [undefined, null, '', '   ']) {
      expect(validateProjectAwsDefaultProfile(raw, { dev: VALID })).toBeNull();
    }
  });

  it('trims and accepts a name present in the profile map', () => {
    expect(validateProjectAwsDefaultProfile(' dev ', { dev: VALID })).toBe('dev');
  });

  it('rejects a name that is not a configured profile', () => {
    expect(() => validateProjectAwsDefaultProfile('staging', { dev: VALID })).toThrow(
      ProjectAwsProfileValidationError,
    );
  });

  it('rejects a non-string designation', () => {
    expect(() => validateProjectAwsDefaultProfile(42, { dev: VALID })).toThrow(
      ProjectAwsProfileValidationError,
    );
  });
});

describe('resolveProjectAwsDefaultProfile', () => {
  // Without a resolved default, `aws sso login` (no --profile) falls back to a
  // `[default]` section the generated config never has and errors out.
  it('falls back to the sole profile when none is designated', () => {
    expect(resolveProjectAwsDefaultProfile({ dev: VALID }, null)).toBe('dev');
  });

  it('prefers the designation over the alphabetical first', () => {
    expect(resolveProjectAwsDefaultProfile({ dev: VALID, prod: VALID }, 'prod')).toBe('prod');
  });

  it('returns null when several profiles exist and none is designated', () => {
    expect(resolveProjectAwsDefaultProfile({ dev: VALID, prod: VALID }, null)).toBeNull();
  });

  it('ignores a stale designation naming a deleted profile', () => {
    expect(resolveProjectAwsDefaultProfile({ dev: VALID, prod: VALID }, 'gone')).toBeNull();
    expect(resolveProjectAwsDefaultProfile({ dev: VALID }, 'gone')).toBe('dev');
  });

  it('returns null for an empty profile map', () => {
    expect(resolveProjectAwsDefaultProfile({}, 'dev')).toBeNull();
  });
});
