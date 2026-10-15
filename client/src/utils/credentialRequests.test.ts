import { describe, it, expect } from 'vitest';
import { parseCredentialRequestEnvelope, parsePersistTarget } from './credentialRequests';

describe('parsePersistTarget', () => {
  const fieldKeys = new Set(['username', 'password']);

  it('accepts a valid target mapping declared field keys', () => {
    expect(
      parsePersistTarget(
        {
          skillId: 'acme-tracker',
          map: {
            username: 'ACMETRACKER_API_DATA_USERNAME',
            password: 'ACMETRACKER_API_DATA_PASSWORD',
          },
        },
        fieldKeys,
      ),
    ).toEqual({
      skillId: 'acme-tracker',
      map: {
        username: 'ACMETRACKER_API_DATA_USERNAME',
        password: 'ACMETRACKER_API_DATA_PASSWORD',
      },
    });
  });

  it('rejects a map that references an unknown field key', () => {
    expect(
      parsePersistTarget({ skillId: 'acme-tracker', map: { nope: 'KEY' } }, fieldKeys),
    ).toBeUndefined();
  });

  it('rejects a bad skill id, empty map, or non-env key name', () => {
    expect(
      parsePersistTarget({ skillId: 'bad id', map: { username: 'K' } }, fieldKeys),
    ).toBeUndefined();
    expect(parsePersistTarget({ skillId: 'acme-tracker', map: {} }, fieldKeys)).toBeUndefined();
    expect(
      parsePersistTarget({ skillId: 'acme-tracker', map: { username: '1BAD' } }, fieldKeys),
    ).toBeUndefined();
  });

  it('rejects a map with duplicate destination credential keys', () => {
    expect(
      parsePersistTarget(
        { skillId: 'acme-tracker', map: { username: 'LOGIN', password: 'LOGIN' } },
        fieldKeys,
      ),
    ).toBeUndefined();
  });
});

describe('parseCredentialRequestEnvelope with persist', () => {
  it('attaches a valid persist target to the parsed block', () => {
    const block = parseCredentialRequestEnvelope(
      JSON.stringify({
        requestId: 'acme-tracker-login',
        service: 'Acme Tracker',
        purpose: 'Sign in.',
        fields: [
          { key: 'username', label: 'Username', type: 'username' },
          { key: 'password', label: 'Password', type: 'password' },
        ],
        persist: {
          skillId: 'acme-tracker',
          map: { username: 'ACMETRACKER_API_DATA_USERNAME' },
        },
      }),
    );
    expect(block?.persist).toEqual({
      skillId: 'acme-tracker',
      map: { username: 'ACMETRACKER_API_DATA_USERNAME' },
    });
  });

  it('omits persist when the target is invalid, still parsing the block', () => {
    const block = parseCredentialRequestEnvelope(
      JSON.stringify({
        requestId: 'x',
        service: 'X',
        purpose: 'Y',
        fields: [{ key: 'password', label: 'Password', type: 'password' }],
        persist: { skillId: 'x', map: { unknownField: 'KEY' } },
      }),
    );
    expect(block).not.toBeNull();
    expect(block?.persist).toBeUndefined();
  });
});
