import { describe, expect, it } from 'vitest';
import {
  buildSkillAuthenticationPreset,
  skillAuthenticationEnvPrefix,
} from './skillAuthentication';

describe('skill authentication presets', () => {
  it('normalizes a project skill slug into a POSIX env prefix', () => {
    expect(skillAuthenticationEnvPrefix('acmetracker-api-data')).toBe('ACMETRACKER_API_DATA');
    expect(skillAuthenticationEnvPrefix('---')).toBe('SKILL');
  });

  it('builds a required masked API-key declaration', () => {
    expect(buildSkillAuthenticationPreset('billing-api', 'api-key')).toEqual([
      {
        name: 'BILLING_API_API_KEY',
        label: 'API key',
        type: 'secret',
        required: true,
      },
    ]);
  });

  it('builds username and password declarations with only the password masked', () => {
    expect(buildSkillAuthenticationPreset('acme-tracker', 'username-password')).toEqual([
      {
        name: 'ACME_TRACKER_USERNAME',
        label: 'Username',
        type: 'string',
        required: true,
      },
      {
        name: 'ACME_TRACKER_PASSWORD',
        label: 'Password',
        type: 'secret',
        required: true,
      },
    ]);
  });
});
