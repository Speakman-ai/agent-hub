import { describe, expect, it } from 'vitest';
import { emptyProfile, rowsToProfiles } from './ProjectAwsProfilesEditor';

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
