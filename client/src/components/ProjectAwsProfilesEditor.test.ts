import { describe, expect, it } from 'vitest';
import {
  ambientCredentialSourceLabel,
  effectiveDefaultProfile,
  effectiveMonitoringProfile,
  emptyProfile,
  monitoringProfileCandidates,
  profilesToRows,
  roleNeedsUnreachableEnvCredentials,
  rowsToProfiles,
} from './ProjectAwsProfilesEditor';

const ROLE_ARN = 'arn:aws:iam::123456789012:role/AgentHubMonitoring';

describe('ProjectAwsProfilesEditor profile serialization', () => {
  it('serializes a new static profile without requiring a session token', () => {
    const row = {
      ...emptyProfile(),
      type: 'static',
      name: 'dev',
      aws_access_key_id: ' AKIATESTKEY ',
      aws_secret_access_key: ' secret-test-key ',
      region: ' us-east-2 ',
    };

    expect(rowsToProfiles([row])).toEqual({
      dev: {
        type: 'static',
        aws_access_key_id: 'AKIATESTKEY',
        aws_secret_access_key: 'secret-test-key',
        region: 'us-east-2',
      },
    });
  });

  // A blank credential source means "follow the Hub runtime". Materializing a
  // concrete value here would pin every new role profile to whatever default
  // the editor happened to render, which is the EC2-only assumption again.
  it('omits credential_source entirely when the row leaves it automatic', () => {
    const row = {
      ...emptyProfile(),
      type: 'role',
      name: 'monitoring',
      role_arn: ` ${ROLE_ARN} `,
      region: ' us-east-2 ',
    };

    expect(rowsToProfiles([row])).toEqual({
      monitoring: { type: 'role', role_arn: ROLE_ARN, region: 'us-east-2' },
    });
  });

  it('sends an explicitly pinned credential source', () => {
    const row = {
      ...emptyProfile(),
      type: 'role',
      name: 'monitoring',
      role_arn: ROLE_ARN,
      credential_source: 'EcsContainer',
      region: 'us-east-2',
    };

    expect(rowsToProfiles([row]).monitoring).toMatchObject({ credential_source: 'EcsContainer' });
  });

  it('keeps external id and session name when set', () => {
    const row = {
      ...emptyProfile(),
      type: 'role',
      name: 'monitoring',
      role_arn: ROLE_ARN,
      external_id: ' ext-123 ',
      role_session_name: ' agent-hub ',
      region: 'us-east-2',
    };

    expect(rowsToProfiles([row]).monitoring).toMatchObject({
      external_id: 'ext-123',
      role_session_name: 'agent-hub',
    });
  });

  // The AWS CLI rejects a stanza carrying both origins, so a chained row must
  // not ship the editor's default credential_source alongside source_profile.
  it('drops credential_source when the role chains from another profile', () => {
    const row = {
      ...emptyProfile(),
      type: 'role',
      name: 'monitoring',
      role_arn: ROLE_ARN,
      source_profile: 'base',
      region: 'us-east-2',
    };

    expect(rowsToProfiles([row]).monitoring).toEqual({
      type: 'role',
      role_arn: ROLE_ARN,
      region: 'us-east-2',
      source_profile: 'base',
    });
  });

  it('leaves role fields out of an SSO profile', () => {
    const row = { ...emptyProfile(), name: 'dev', sso_account_id: '123456789012' };
    expect(rowsToProfiles([row]).dev).not.toHaveProperty('role_arn');
  });

  it('keeps a configured output format on every profile kind', () => {
    const rows = [
      { ...emptyProfile(), name: 'dev', output: ' yaml ' },
      { ...emptyProfile(), type: 'static', name: 'keys', output: 'text' },
      { ...emptyProfile(), type: 'role', name: 'monitoring', role_arn: ROLE_ARN, output: 'table' },
    ];
    const profiles = rowsToProfiles(rows);
    expect(profiles.dev.output).toBe('yaml');
    expect(profiles.keys.output).toBe('text');
    expect(profiles.monitoring.output).toBe('table');
  });

  it('omits a blank output rather than persisting an empty string', () => {
    expect(rowsToProfiles([{ ...emptyProfile(), name: 'dev' }]).dev).not.toHaveProperty('output');
  });
});

// The reported bug: `output` was never read back into a row, so opening the
// AWS settings panel and pressing Save silently erased it from storage.
describe('load → save round trip', () => {
  const cases: Record<string, any> = {
    dev: {
      type: 'sso',
      sso_account_id: '123456789012',
      sso_start_url: 'https://d-1234567890.awsapps.com/start/',
      sso_region: 'us-east-2',
      sso_role_name: 'AdministratorAccess',
      region: 'us-east-2',
      output: 'yaml',
    },
    keys: {
      type: 'static',
      aws_access_key_id: 'AKIATESTKEY',
      aws_secret_access_key: 'secret-test-key',
      aws_session_token: 'session-token',
      region: 'us-east-2',
      output: 'text',
    },
    monitoring: {
      type: 'role',
      role_arn: ROLE_ARN,
      external_id: 'ext-123',
      role_session_name: 'agent-hub',
      credential_source: 'EcsContainer',
      region: 'us-east-2',
      output: 'table',
    },
  };

  it('returns every stored profile unchanged when nothing is edited', () => {
    expect(rowsToProfiles(profilesToRows(cases))).toEqual(cases);
  });

  it('leaves an automatic credential source automatic', () => {
    const stored = { monitoring: { type: 'role', role_arn: ROLE_ARN, region: 'us-east-2' } };
    expect(rowsToProfiles(profilesToRows(stored))).toEqual(stored);
  });
});

describe('ambientCredentialSourceLabel', () => {
  it('names the source the Hub resolved so the automatic option is not a guess', () => {
    expect(ambientCredentialSourceLabel('EcsContainer')).toBe('Automatic — EcsContainer');
  });

  it('stays generic before the server has reported one', () => {
    expect(ambientCredentialSourceLabel('')).toBe('Automatic (Hub runtime)');
    expect(ambientCredentialSourceLabel(undefined)).toBe('Automatic (Hub runtime)');
  });
});

describe('roleNeedsUnreachableEnvCredentials', () => {
  const role = (extra: any = {}) => ({
    ...emptyProfile(),
    type: 'role',
    name: 'monitoring',
    role_arn: ROLE_ARN,
    ...extra,
  });

  it('warns when the role inherits an Environment source from the Hub runtime', () => {
    expect(roleNeedsUnreachableEnvCredentials(role(), 'Environment')).toBe(true);
  });

  it('warns when the row pins Environment on a non-Environment Hub', () => {
    expect(
      roleNeedsUnreachableEnvCredentials(
        role({ credential_source: 'Environment' }),
        'EcsContainer',
      ),
    ).toBe(true);
  });

  it('stays quiet for reachable sources', () => {
    expect(roleNeedsUnreachableEnvCredentials(role(), 'Ec2InstanceMetadata')).toBe(false);
    expect(
      roleNeedsUnreachableEnvCredentials(
        role({ credential_source: 'EcsContainer' }),
        'Environment',
      ),
    ).toBe(false);
  });

  // A chained role never reads the Hub's ambient credentials at all.
  it('stays quiet for a chained role even on an Environment Hub', () => {
    expect(
      roleNeedsUnreachableEnvCredentials(role({ source_profile: 'base' }), 'Environment'),
    ).toBe(false);
  });

  it('ignores non-role rows', () => {
    expect(
      roleNeedsUnreachableEnvCredentials({ ...emptyProfile(), name: 'dev' }, 'Environment'),
    ).toBe(false);
  });
});

describe('effectiveDefaultProfile', () => {
  const row = (name: string) => ({ ...emptyProfile(), name });

  // The reported bug: with no resolved default, `aws sso login` in the Terminal
  // falls back to a `[default]` section the generated config never has.
  it('falls back to the sole profile when none is designated', () => {
    expect(effectiveDefaultProfile([row('dev')], '')).toBe('dev');
  });

  it('honours the designation and trims it', () => {
    expect(effectiveDefaultProfile([row('dev'), row('prod')], ' prod ')).toBe('prod');
  });

  it('returns nothing when several profiles exist and none is designated', () => {
    expect(effectiveDefaultProfile([row('dev'), row('prod')], '')).toBe('');
  });

  it('drops a designation left over from a renamed row', () => {
    expect(effectiveDefaultProfile([row('dev'), row('staging')], 'prod')).toBe('');
    expect(effectiveDefaultProfile([row('dev')], 'prod')).toBe('dev');
  });

  it('ignores unnamed rows', () => {
    expect(effectiveDefaultProfile([row('dev'), row('  ')], '')).toBe('dev');
  });
});

describe('monitoring profile designation', () => {
  const row = (name: string, type = 'sso') => ({ ...emptyProfile(), name, type });

  // The server rejects an SSO designation outright, so the option must never
  // reach the picker: an SSO token caches under a user's home and expires with
  // nobody around to re-run `aws sso login`.
  it('offers only static and assume-role rows', () => {
    expect(
      monitoringProfileCandidates([row('dev'), row('keys', 'static'), row('monitoring', 'role')]),
    ).toEqual(['keys', 'monitoring']);
  });

  it('ignores unnamed rows', () => {
    expect(monitoringProfileCandidates([row('  ', 'role'), row('monitoring', 'role')])).toEqual([
      'monitoring',
    ]);
  });

  it('honours an eligible designation and trims it', () => {
    expect(effectiveMonitoringProfile([row('monitoring', 'role')], ' monitoring ')).toBe(
      'monitoring',
    );
  });

  // Unlike the interactive default, spending AWS API budget unattended stays
  // an explicit choice — no sole-profile fallback.
  it('does not fall back to the sole eligible row', () => {
    expect(effectiveMonitoringProfile([row('monitoring', 'role')], '')).toBe('');
  });

  it('drops a designation left over from a renamed row', () => {
    expect(effectiveMonitoringProfile([row('collector', 'role')], 'monitoring')).toBe('');
  });

  // Flipping the designated row to SSO must drop the designation client-side,
  // or the save 400s on an edit the operator already made.
  it('drops a designation whose row switched to SSO', () => {
    expect(effectiveMonitoringProfile([row('monitoring', 'sso')], 'monitoring')).toBe('');
  });
});
