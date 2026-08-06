import { describe, expect, it } from 'vitest';
import { awsProfileBadges } from './awsProfileBadges';

describe('awsProfileBadges', () => {
  it('marks the interactive default', () => {
    expect(awsProfileBadges('prod', { defaultProfile: 'prod' })).toBe('  ·  default');
  });

  it('marks the profile background collection runs as', () => {
    expect(awsProfileBadges('monitoring', { monitoringProfile: 'monitoring' })).toBe(
      '  ·  monitoring',
    );
  });

  // The two designations are independent knobs and one profile may hold both.
  it('marks both when the same profile holds both designations', () => {
    expect(awsProfileBadges('ops', { defaultProfile: 'ops', monitoringProfile: 'ops' })).toBe(
      '  ·  default · monitoring',
    );
  });

  it('marks nothing for an undesignated profile', () => {
    expect(awsProfileBadges('dev', { defaultProfile: 'prod', monitoringProfile: 'ops' })).toBe('');
    expect(awsProfileBadges('dev')).toBe('');
  });

  it('does not mark an unnamed row against absent designations', () => {
    expect(awsProfileBadges('', {})).toBe('');
  });
});
