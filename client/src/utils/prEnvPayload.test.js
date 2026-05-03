import { describe, it, expect } from 'vitest';
import { buildPrEnvSavePayload, validatePrEnvForm } from './prEnvPayload.js';

/**
 * Pin the contract: the UI no longer ships GitHub App or Route 53
 * credentials. Those are sourced from infrastructure (`config.githubApp`
 * for the registered Reviewer App, AWS SDK default chain / IMDSv2 for
 * Route 53). Anything in the form that resembles a credential field must
 * be dropped from the outgoing PUT payload — silent re-posting of stale
 * Tier 2 values would override the inherited identity.
 */

/** A form state mirroring GET output after the user loaded the page but has not edited. */
function loadedForm() {
  return {
    enabled: true,
    repoFullName: 'acme/widgets',
    previewHost: '*.preview.example.com',
    previewBaseUrl: 'https://pr-{{number}}.preview.example.com',
    certRenewalLive: true,
    portRangeMin: 8000,
    portRangeMax: 8999,
  };
}

const TIER2_KEYS = [
  'githubAppId',
  'githubInstallationId',
  'githubPrivateKey',
  'route53AccessKeyId',
  'route53SecretAccessKey',
  'route53HostedZoneId',
];

describe('buildPrEnvSavePayload — Tier 2 inheritance from infrastructure', () => {
  it('does not include any Tier 2 credential fields, even if present on the form', () => {
    // Even if a stale form somehow holds these (e.g. legacy state, test fixture),
    // the payload builder must drop them.
    const stale = {
      ...loadedForm(),
      githubAppId: '123',
      githubInstallationId: '7890',
      githubPrivateKey: 'pk',
      route53AccessKeyId: 'AKIA',
      route53SecretAccessKey: 'sekret',
      route53HostedZoneId: 'Z0123',
    };
    const payload = buildPrEnvSavePayload(stale);
    for (const k of TIER2_KEYS) {
      expect(payload, `must not include Tier 2 field ${k}`).not.toHaveProperty(k);
    }
  });

  it('includes Tier 1 string and boolean fields verbatim', () => {
    const payload = buildPrEnvSavePayload(loadedForm());
    expect(payload.repoFullName).toBe('acme/widgets');
    expect(payload.previewHost).toBe('*.preview.example.com');
    expect(payload.previewBaseUrl).toBe('https://pr-{{number}}.preview.example.com');
    expect(payload.enabled).toBe(true);
    expect(payload.certRenewalLive).toBe(true);
  });

  it('coerces port range strings into numbers, empty → null', () => {
    const form = { ...loadedForm(), portRangeMin: '9000', portRangeMax: '9100' };
    expect(buildPrEnvSavePayload(form)).toMatchObject({
      portRangeMin: 9000,
      portRangeMax: 9100,
    });

    const cleared = { ...loadedForm(), portRangeMin: '', portRangeMax: '' };
    expect(buildPrEnvSavePayload(cleared)).toMatchObject({
      portRangeMin: null,
      portRangeMax: null,
    });
  });

  it('always includes the enabled and certRenewalLive booleans', () => {
    const off = buildPrEnvSavePayload({
      ...loadedForm(),
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
      ...loadedForm(),
      portRangeMin: 8000,
      portRangeMax: '',
    });
    expect(errs.some((e) => /min and max/i.test(e))).toBe(true);
  });

  it('rejects max < min', () => {
    const errs = validatePrEnvForm({
      ...loadedForm(),
      portRangeMin: 9000,
      portRangeMax: 8000,
    });
    expect(errs.some((e) => /max/i.test(e))).toBe(true);
  });

  it('rejects enabling without a repo configured', () => {
    const errs = validatePrEnvForm({ ...loadedForm(), repoFullName: '', enabled: true });
    expect(errs.some((e) => /repo/i.test(e))).toBe(true);
  });

  it('accepts a fully valid form', () => {
    expect(validatePrEnvForm(loadedForm())).toEqual([]);
  });
});
