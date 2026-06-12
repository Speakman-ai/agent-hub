import { describe, it, expect } from 'vitest';
import {
  SECRET_MASK,
  validateSecretKey,
  buildUpsertSecretsPayload,
  displaySecretValue,
  describeSecretsPermissionError,
} from './settingsSecrets.js';

describe('validateSecretKey', () => {
  it('accepts env-style keys', () => {
    expect(validateSecretKey('DATABASE_URL')).toBeNull();
    expect(validateSecretKey('_private')).toBeNull();
    expect(validateSecretKey('Key2')).toBeNull();
  });

  it('rejects empty and malformed keys', () => {
    expect(validateSecretKey('')).toMatch(/required/);
    expect(validateSecretKey('  ')).toMatch(/required/);
    expect(validateSecretKey('2BAD')).toMatch(/must start/);
    expect(validateSecretKey('HAS-DASH')).toMatch(/must start/);
  });

  it('rejects reserved keys (server parity)', () => {
    expect(validateSecretKey('AGENT_HUB_URL')).toMatch(/reserved/);
    expect(validateSecretKey('NODE_ENV')).toMatch(/reserved/);
    expect(validateSecretKey('PATH')).toMatch(/reserved/);
    expect(validateSecretKey('HOME')).toMatch(/reserved/);
    // PATH/HOME are only reserved as exact names
    expect(validateSecretKey('PATHLIKE')).toBeNull();
    expect(validateSecretKey('HOMEDIR')).toBeNull();
  });
});

describe('buildUpsertSecretsPayload', () => {
  const existing = [
    { key: 'A', value: SECRET_MASK, kind: 'secret' },
    { key: 'B', value: 'visible', kind: 'plain' },
  ];

  it('keeps existing rows (mask preserved) and appends the new entry', () => {
    const payload = buildUpsertSecretsPayload(existing, { key: 'C', value: 'v', kind: 'secret' });
    expect(payload).toEqual([
      { key: 'A', value: SECRET_MASK, kind: 'secret' },
      { key: 'B', value: 'visible', kind: 'plain' },
      { key: 'C', value: 'v', kind: 'secret' },
    ]);
  });

  it('replaces a same-key row instead of duplicating it', () => {
    const payload = buildUpsertSecretsPayload(existing, { key: 'A', value: 'new', kind: 'plain' });
    expect(payload.filter((r) => r.key === 'A')).toEqual([{ key: 'A', value: 'new', kind: 'plain' }]);
    expect(payload).toHaveLength(2);
  });

  it('defaults kind to secret and trims the key', () => {
    const payload = buildUpsertSecretsPayload([], { key: ' K ', value: 'v' });
    expect(payload).toEqual([{ key: 'K', value: 'v', kind: 'secret' }]);
  });

  it('tolerates a non-array existing list', () => {
    expect(buildUpsertSecretsPayload(null, { key: 'K', value: 'v' })).toHaveLength(1);
  });
});

describe('displaySecretValue', () => {
  it('masks secret-kind rows and shows plain rows', () => {
    expect(displaySecretValue({ kind: 'secret', value: 'whatever' })).toBe(SECRET_MASK);
    expect(displaySecretValue({ kind: 'plain', value: 'abc' })).toBe('abc');
    expect(displaySecretValue({ kind: 'plain' })).toBe('');
    expect(displaySecretValue(null)).toBe('');
  });
});

describe('describeSecretsPermissionError', () => {
  it('maps 403 errors to role guidance by action', () => {
    const err = new Error('403: Forbidden');
    expect(describeSecretsPermissionError(err, 'read')).toMatch(/Admin/);
    expect(describeSecretsPermissionError(err, 'write')).toMatch(/Owner/);
  });

  it('returns null for non-permission errors', () => {
    expect(describeSecretsPermissionError(new Error('500: boom'))).toBeNull();
    expect(describeSecretsPermissionError(new Error('network down'))).toBeNull();
    expect(describeSecretsPermissionError(null)).toBeNull();
  });
});
