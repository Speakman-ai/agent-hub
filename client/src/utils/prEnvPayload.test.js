import { describe, it, expect } from 'vitest';
import {
  MASK,
  SECRET_FIELDS,
  buildPrEnvSavePayload,
  validatePrEnvForm,
  isMaskValue,
} from './prEnvPayload.js';

/**
 * The mask-preservation contract is the single most error-prone invariant in
 * this settings page: if we accidentally re-post `••••••••` as the new secret
 * value we'd encrypt the sentinel at rest and silently nuke real credentials.
 * These tests pin the contract.
 */

/** A form state mirroring GET output after the user loaded the page but has not edited. */
function maskedLoadedForm() {
  return {
    enabled: true,
    repoFullName: 'acme/widgets',
    previewHost: '*.preview.example.com',
    previewBaseUrl: 'https://pr-{{number}}.preview.example.com',
    certRenewalLive: true,
    portRangeMin: 8000,
    portRangeMax: 8999,
    githubAppId: '123456',
    githubInstallationId: '7890',
    githubPrivateKey: MASK, // unchanged — must not be re-sent
    route53AccessKeyId: 'AKIA...',
    route53SecretAccessKey: MASK, // unchanged — must not be re-sent
    route53HostedZoneId: 'Z0123',
  };
}

describe('isMaskValue', () => {
  it('returns true only for the mask sentinel', () => {
    expect(isMaskValue(MASK)).toBe(true);
    expect(isMaskValue('')).toBe(false);
    expect(isMaskValue('abc')).toBe(false);
    expect(isMaskValue(undefined)).toBe(false);
    expect(isMaskValue(null)).toBe(false);
  });
});

describe('buildPrEnvSavePayload — mask preservation', () => {
  it('drops masked secrets so the server preserves the stored values', () => {
    const payload = buildPrEnvSavePayload(maskedLoadedForm());
    for (const secret of SECRET_FIELDS) {
      expect(payload, `must not include untouched masked ${secret}`).not.toHaveProperty(secret);
    }
  });

  it('includes non-secret Tier 2 fields even when unchanged', () => {
    const payload = buildPrEnvSavePayload(maskedLoadedForm());
    expect(payload.githubAppId).toBe('123456');
    expect(payload.githubInstallationId).toBe('7890');
    expect(payload.route53AccessKeyId).toBe('AKIA...');
    expect(payload.route53HostedZoneId).toBe('Z0123');
  });

  it('includes a secret when the user replaces the mask with a real value', () => {
    const form = {
      ...maskedLoadedForm(),
      githubPrivateKey: '-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----',
    };
    const payload = buildPrEnvSavePayload(form);
    expect(payload.githubPrivateKey).toContain('BEGIN RSA PRIVATE KEY');
    // Unchanged sibling secret still preserved:
    expect(payload).not.toHaveProperty('route53SecretAccessKey');
  });

  it('includes an empty string when the user explicitly clears a secret', () => {
    const form = { ...maskedLoadedForm(), route53SecretAccessKey: '' };
    const payload = buildPrEnvSavePayload(form);
    expect(payload).toHaveProperty('route53SecretAccessKey', '');
  });

  it('coerces port range strings into numbers, empty → null', () => {
    const form = { ...maskedLoadedForm(), portRangeMin: '9000', portRangeMax: '9100' };
    expect(buildPrEnvSavePayload(form)).toMatchObject({
      portRangeMin: 9000,
      portRangeMax: 9100,
    });

    const cleared = { ...maskedLoadedForm(), portRangeMin: '', portRangeMax: '' };
    expect(buildPrEnvSavePayload(cleared)).toMatchObject({
      portRangeMin: null,
      portRangeMax: null,
    });
  });

  it('always includes the enabled and certRenewalLive booleans', () => {
    const off = buildPrEnvSavePayload({
      ...maskedLoadedForm(),
      enabled: false,
      certRenewalLive: false,
    });
    expect(off.enabled).toBe(false);
    expect(off.certRenewalLive).toBe(false);
  });
});

describe('validatePrEnvForm', () => {
  it('rejects a half-set port range', () => {
    const errs = validatePrEnvForm({
      ...maskedLoadedForm(),
      portRangeMin: 8000,
      portRangeMax: '',
    });
    expect(errs.some((e) => /min and max/i.test(e))).toBe(true);
  });

  it('rejects max < min', () => {
    const errs = validatePrEnvForm({
      ...maskedLoadedForm(),
      portRangeMin: 9000,
      portRangeMax: 8000,
    });
    expect(errs.some((e) => /max/i.test(e))).toBe(true);
  });

  it('rejects enabling without a repo configured', () => {
    const errs = validatePrEnvForm({ ...maskedLoadedForm(), repoFullName: '', enabled: true });
    expect(errs.some((e) => /repo/i.test(e))).toBe(true);
  });

  it('accepts a fully valid masked-load form', () => {
    expect(validatePrEnvForm(maskedLoadedForm())).toEqual([]);
  });
});
