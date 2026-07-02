import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  isLoopbackHost,
  isAllowedFetchTarget,
  installTestNetworkGuard,
  LiveDeploymentNetworkError,
} from './network-guard.js';

describe('isLoopbackHost', () => {
  it('accepts loopback literals and the 127.0.0.0/8 block', () => {
    for (const h of [
      'localhost',
      'LOCALHOST',
      '127.0.0.1',
      '127.0.0.2',
      '127.255.255.254',
      '::1',
      '0.0.0.0',
    ]) {
      expect(isLoopbackHost(h)).toBe(true);
    }
  });

  it('rejects real/remote hosts', () => {
    for (const h of [
      'hub.example.com',
      'api.github.com',
      '169.254.169.254',
      '8.8.8.8',
      'example.test',
      '10.0.0.5',
    ]) {
      expect(isLoopbackHost(h)).toBe(false);
    }
  });
});

describe('isAllowedFetchTarget', () => {
  it('allows loopback http(s) targets in every fetch input shape', () => {
    expect(isAllowedFetchTarget('http://localhost:3051/api/config')).toBe(true);
    expect(isAllowedFetchTarget('https://127.0.0.1:8443/x')).toBe(true);
    expect(isAllowedFetchTarget(new URL('http://127.0.0.2:4100/'))).toBe(true);
    expect(isAllowedFetchTarget({ url: 'http://[::1]:9000/ping' })).toBe(true);
  });

  it('blocks non-loopback http(s) targets', () => {
    expect(isAllowedFetchTarget('https://hub.example.com/api')).toBe(false);
    expect(isAllowedFetchTarget('http://prod.internal/deploy')).toBe(false);
    expect(isAllowedFetchTarget(new URL('https://api.github.com/repos/o/r'))).toBe(false);
    expect(isAllowedFetchTarget({ url: 'http://169.254.169.254/latest/meta-data/' })).toBe(false);
  });

  it('allows non-network schemes and unparseable/relative targets', () => {
    expect(isAllowedFetchTarget('data:text/plain,hi')).toBe(true);
    expect(isAllowedFetchTarget('/api/relative')).toBe(true);
    expect(isAllowedFetchTarget('not a url')).toBe(true);
    expect(isAllowedFetchTarget(null)).toBe(true);
  });
});

describe('installTestNetworkGuard', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function freshEnv(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
    return { ...overrides } as NodeJS.ProcessEnv;
  }

  it('blocks a non-loopback fetch and never calls the real fetch', () => {
    const realFetch = vi.fn(async () => new Response('ok'));
    const g: { fetch?: typeof fetch } = { fetch: realFetch as unknown as typeof fetch };
    installTestNetworkGuard(g as never, freshEnv());

    expect(() => g.fetch!('https://hub.example.com/deploy')).toThrow(LiveDeploymentNetworkError);
    expect(realFetch).not.toHaveBeenCalled();
  });

  it('lets loopback fetches through to the real implementation', async () => {
    const realFetch = vi.fn(async () => new Response('ok'));
    const g: { fetch?: typeof fetch } = { fetch: realFetch as unknown as typeof fetch };
    installTestNetworkGuard(g as never, freshEnv());

    await g.fetch!('http://127.0.0.1:3051/api/config');
    expect(realFetch).toHaveBeenCalledTimes(1);
  });

  it('honours the AGENT_HUB_ALLOW_TEST_NETWORK=1 escape hatch', async () => {
    const realFetch = vi.fn(async () => new Response('ok'));
    const g: { fetch?: typeof fetch } = { fetch: realFetch as unknown as typeof fetch };
    installTestNetworkGuard(g as never, freshEnv({ AGENT_HUB_ALLOW_TEST_NETWORK: '1' }));

    await g.fetch!('https://hub.example.com/deploy');
    expect(realFetch).toHaveBeenCalledTimes(1);
  });

  it('is idempotent and re-wraps the original, not a leaked mock', () => {
    const realFetch = vi.fn(async () => new Response('real'));
    const g: { fetch?: typeof fetch } = { fetch: realFetch as unknown as typeof fetch };
    installTestNetworkGuard(g as never, freshEnv());
    const firstGuard = g.fetch;

    // Simulate a test leaking a mock that never gets restored.
    const leaked = vi.fn(async () => new Response('leaked'));
    g.fetch = leaked as unknown as typeof fetch;

    // Re-running setup restores a guard over the ORIGINAL fetch, not the leak.
    installTestNetworkGuard(g as never, freshEnv());
    expect(g.fetch).not.toBe(leaked);
    expect(() => g.fetch!('https://hub.example.com/x')).toThrow(LiveDeploymentNetworkError);
    expect(leaked).not.toHaveBeenCalled();

    // Double-install without a leak is a no-op wrapper churn but stays a guard.
    installTestNetworkGuard(g as never, freshEnv());
    expect(() => g.fetch!('https://evil.test/x')).toThrow(LiveDeploymentNetworkError);
    void firstGuard;
  });

  it('does nothing when there is no global fetch', () => {
    const g: { fetch?: typeof fetch } = {};
    expect(() => installTestNetworkGuard(g as never, freshEnv())).not.toThrow();
    expect(g.fetch).toBeUndefined();
  });
});
