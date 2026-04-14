/**
 * Tests for github-app.js — resolveInstallationId and token cache.
 */

import { describe, it, expect } from 'vitest';
import { resolveInstallationId } from './github-app.js';

describe('resolveInstallationId', () => {
  it('returns null when config is null', () => {
    expect(resolveInstallationId(null, 'some-org')).toBeNull();
  });

  it('returns null when config is undefined', () => {
    expect(resolveInstallationId(undefined, 'some-org')).toBeNull();
  });

  it('returns legacy installationId when no installations array', () => {
    const config = { installationId: '123' };
    expect(resolveInstallationId(config, 'some-org')).toBe('123');
  });

  it('returns legacy installationId when owner is not provided', () => {
    const config = {
      installationId: '123',
      installations: [{ id: '456', account: 'my-org' }],
    };
    expect(resolveInstallationId(config)).toBe('123');
  });

  it('returns matching installation ID when owner matches', () => {
    const config = {
      installationId: '123',
      installations: [
        { id: '456', account: 'personal' },
        { id: '789', account: 'my-org' },
      ],
    };
    expect(resolveInstallationId(config, 'my-org')).toBe('789');
  });

  it('matches owner case-insensitively', () => {
    const config = {
      installationId: '123',
      installations: [{ id: '456', account: 'My-Org' }],
    };
    expect(resolveInstallationId(config, 'my-org')).toBe('456');
    expect(resolveInstallationId(config, 'MY-ORG')).toBe('456');
  });

  it('falls back to legacy installationId when owner has no match', () => {
    const config = {
      installationId: '123',
      installations: [{ id: '456', account: 'other-org' }],
    };
    expect(resolveInstallationId(config, 'unknown-org')).toBe('123');
  });

  it('returns null when no match and no legacy fallback', () => {
    const config = {
      installations: [{ id: '456', account: 'other-org' }],
    };
    expect(resolveInstallationId(config, 'unknown-org')).toBeNull();
  });

  it('handles installations with missing account gracefully', () => {
    const config = {
      installationId: '123',
      installations: [{ id: '456' }, { id: '789', account: 'my-org' }],
    };
    expect(resolveInstallationId(config, 'my-org')).toBe('789');
  });

  it('returns first match when multiple installations match', () => {
    const config = {
      installations: [
        { id: '111', account: 'my-org' },
        { id: '222', account: 'my-org' },
      ],
    };
    expect(resolveInstallationId(config, 'my-org')).toBe('111');
  });
});
