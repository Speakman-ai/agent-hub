import { describe, it, expect } from 'vitest';
import {
  validateProjectAwsSsoProfiles,
  validateProjectAwsDefaultProfile,
  resolveProjectAwsDefaultProfile,
  renderProjectAwsConfigIni,
  renderProjectAwsCredentialsIni,
  ProjectAwsProfileValidationError,
} from './project-aws-profiles.js';

const VALID = {
  sso_account_id: '120569607241',
  sso_start_url: 'https://d-9a670b4c46.awsapps.com/start/#',
  sso_region: 'us-east-2',
  sso_role_name: 'AdministratorAccess',
  region: 'us-east-2',
};

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
