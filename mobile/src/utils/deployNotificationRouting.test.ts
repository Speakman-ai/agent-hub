import { describe, it, expect } from 'vitest';
import { summarizeRouting, routingDefaultLabel } from './deployNotificationRouting';

describe('summarizeRouting', () => {
  it('describes nothing when both types are off', () => {
    expect(
      summarizeRouting({ ticketReleaseEnabled: false, releaseDigestEnabled: false }),
    ).toBe('Sends nothing on a successful deploy');
  });

  it('describes a single type', () => {
    expect(
      summarizeRouting({ ticketReleaseEnabled: true, releaseDigestEnabled: false }),
    ).toBe('Sends reporter emails on a successful deploy');
    expect(
      summarizeRouting({ ticketReleaseEnabled: false, releaseDigestEnabled: true }),
    ).toBe('Sends release digest on a successful deploy');
  });

  it('joins both types', () => {
    expect(
      summarizeRouting({ ticketReleaseEnabled: true, releaseDigestEnabled: true }),
    ).toBe('Sends reporter emails + release digest on a successful deploy');
  });
});

describe('routingDefaultLabel', () => {
  it('labels a saved override as custom', () => {
    expect(routingDefaultLabel({ isDefault: false, isProduction: true })).toBe('custom');
    expect(routingDefaultLabel({ isDefault: false, isProduction: false })).toBe('custom');
  });

  it('labels the env-name defaults', () => {
    expect(routingDefaultLabel({ isDefault: true, isProduction: true })).toBe('default (prod)');
    expect(routingDefaultLabel({ isDefault: true, isProduction: false })).toBe('default (off)');
  });
});
