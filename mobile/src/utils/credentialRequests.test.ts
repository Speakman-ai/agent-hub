import { describe, it, expect } from 'vitest';
import { parseCredentialRequestEnvelope, parsePersistTarget } from './credentialRequests';

describe('mobile parsePersistTarget', () => {
  const fieldKeys = new Set(['username', 'password']);

  it('accepts a valid target and trims key names', () => {
    expect(
      parsePersistTarget({ skillId: 'survey-tracker', map: { username: ' USER ' } }, fieldKeys),
    ).toEqual({ skillId: 'survey-tracker', map: { username: 'USER' } });
  });

  it('rejects unknown field keys, bad skill ids, and empty maps', () => {
    expect(
      parsePersistTarget({ skillId: 'survey-tracker', map: { nope: 'K' } }, fieldKeys),
    ).toBeUndefined();
    expect(
      parsePersistTarget({ skillId: 'bad id', map: { username: 'K' } }, fieldKeys),
    ).toBeUndefined();
    expect(parsePersistTarget({ skillId: 'survey-tracker', map: {} }, fieldKeys)).toBeUndefined();
  });

  it('rejects a map with duplicate destination credential keys', () => {
    expect(
      parsePersistTarget(
        { skillId: 'survey-tracker', map: { username: 'LOGIN', password: 'LOGIN' } },
        fieldKeys,
      ),
    ).toBeUndefined();
  });
});

describe('mobile parseCredentialRequestEnvelope with persist', () => {
  it('attaches a valid persist target', () => {
    const block: any = parseCredentialRequestEnvelope(
      JSON.stringify({
        requestId: 'survey-tracker-login',
        service: 'Survey Tracker',
        purpose: 'Sign in.',
        fields: [{ key: 'password', label: 'Password', type: 'password' }],
        persist: {
          skillId: 'survey-tracker',
          map: { password: 'SURVEYTRACKER_API_DATA_PASSWORD' },
        },
      }),
    );
    expect(block?.persist).toEqual({
      skillId: 'survey-tracker',
      map: { password: 'SURVEYTRACKER_API_DATA_PASSWORD' },
    });
  });
});
