/**
 * Tests for the singleton accessor `getIntegrationProvider()`.
 *
 * The accessor is a thin layer over `getIntegrationProviderConfig()`
 * that:
 *   - throws (`IntegrationProviderError` w/ status 503) when the
 *     resolver reports an unconfigured / disabled state, and
 *   - caches the constructed adapter, invalidating when the resolved
 *     tuple `(provider, baseUrl, secretKey, mode)` changes.
 *
 * We exercise both behaviours by stubbing the runtime resolver so the
 * test doesn't have to stand up an `orgs.db`.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  getIntegrationProvider,
  __resetIntegrationProviderCacheForTests,
  IntegrationProviderError,
} from './provider.js';
import * as runtime from '../integration-provider-runtime.js';

beforeEach(() => {
  __resetIntegrationProviderCacheForTests();
});

afterEach(() => {
  vi.restoreAllMocks();
  __resetIntegrationProviderCacheForTests();
});

describe('getIntegrationProvider singleton', () => {
  it('throws IntegrationProviderError when the resolver is unconfigured', () => {
    vi.spyOn(runtime, 'getIntegrationProviderConfig').mockReturnValue({
      ok: false,
      reason: 'shared-mode-missing-env',
      mode: 'shared',
      provider: 'nango-cloud',
      baseUrl: 'https://api.nango.dev',
    });

    let caught: unknown;
    try {
      getIntegrationProvider();
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(IntegrationProviderError);
    expect((caught as IntegrationProviderError).status).toBe(503);
  });

  it('returns the same cached instance when config is unchanged', () => {
    vi.spyOn(runtime, 'getIntegrationProviderConfig').mockReturnValue({
      ok: true,
      mode: 'shared',
      provider: 'nango-cloud',
      secretKey: 'sk-1',
      baseUrl: 'https://api.nango.dev',
      webhookSecret: '',
      enabled: true,
      source: 'env',
    });

    const a = getIntegrationProvider();
    const b = getIntegrationProvider();
    expect(a).toBe(b);
  });

  it('rebuilds the adapter when the secret rotates', () => {
    const spy = vi.spyOn(runtime, 'getIntegrationProviderConfig');
    spy.mockReturnValueOnce({
      ok: true,
      mode: 'shared',
      provider: 'nango-cloud',
      secretKey: 'sk-1',
      baseUrl: 'https://api.nango.dev',
      webhookSecret: '',
      enabled: true,
      source: 'env',
    });
    const a = getIntegrationProvider();

    spy.mockReturnValueOnce({
      ok: true,
      mode: 'shared',
      provider: 'nango-cloud',
      secretKey: 'sk-2-rotated',
      baseUrl: 'https://api.nango.dev',
      webhookSecret: '',
      enabled: true,
      source: 'env',
    });
    const b = getIntegrationProvider();

    expect(b).not.toBe(a);
  });

  it('rebuilds the adapter when baseUrl changes (e.g. self-hosted switch)', () => {
    const spy = vi.spyOn(runtime, 'getIntegrationProviderConfig');
    spy.mockReturnValueOnce({
      ok: true,
      mode: 'shared',
      provider: 'nango-cloud',
      secretKey: 'sk',
      baseUrl: 'https://api.nango.dev',
      webhookSecret: '',
      enabled: true,
      source: 'env',
    });
    const a = getIntegrationProvider();

    spy.mockReturnValueOnce({
      ok: true,
      mode: 'byo',
      provider: 'nango-selfhosted',
      secretKey: 'sk',
      baseUrl: 'https://nango.internal.example',
      webhookSecret: '',
      enabled: true,
      source: 'db',
    });
    const b = getIntegrationProvider();

    expect(b).not.toBe(a);
  });
});
