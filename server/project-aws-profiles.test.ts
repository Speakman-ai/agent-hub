import { describe, it, expect } from 'vitest';
import {
  validateProjectAwsSsoProfiles,
  renderProjectAwsConfigIni,
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
    expect(profiles.dev.sso_start_url).toBe('https://d-9a670b4c46.awsapps.com/start/');
  });

  it('accepts an array with name field', () => {
    const profiles = validateProjectAwsSsoProfiles([{ name: 'staging', ...VALID }]);
    expect(profiles.staging.sso_account_id).toBe(VALID.sso_account_id);
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
});
