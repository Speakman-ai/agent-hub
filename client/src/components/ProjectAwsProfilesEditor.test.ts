import { describe, expect, it } from 'vitest';
import { effectiveDefaultProfile, emptyProfile, rowsToProfiles } from './ProjectAwsProfilesEditor';

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
